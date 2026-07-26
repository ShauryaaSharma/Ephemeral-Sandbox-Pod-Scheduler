import express from "express";
import fs from "fs";
import yaml from "yaml";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();
import { KubeConfig, AppsV1Api, CoreV1Api, NetworkingV1Api, Metrics } from "@kubernetes/client-node";
import { requireAuth } from "./auth";
import { getProject, markStarted, getStartedProjects } from "./db";
import { createStopper } from "./stop";
import { startReaper, getRecentAutoTeardowns } from "./reaper";
import { startHealthMonitor, getRecentAlerts } from "./healthMonitor";
import { getPodResourceUsage } from "./monitor";
import { ensureNamespace, deleteProjectNamespace } from "./namespace";
import { withRetry, checkPodSchedulable, translateK8sError } from "./capacity";
import { rateLimit } from "./rateLimit";

const app = express();
app.use(express.json());
app.use(cors());

// Config-driven instead of baked into the committed service.yaml template -
// WS_DOMAIN also has to match what runner/frontend use to reach a pod (see
// stop.ts/reaper.ts and the frontend's VITE_WS_DOMAIN).
const WS_DOMAIN = process.env.WS_DOMAIN ?? "peetcode.com";
const APP_DOMAIN = process.env.APP_DOMAIN ?? "autogpt-cloud.com";

const kubeconfig = new KubeConfig();
kubeconfig.loadFromDefault();
const coreV1Api = kubeconfig.makeApiClient(CoreV1Api);
const appsV1Api = kubeconfig.makeApiClient(AppsV1Api);
const networkingV1Api = kubeconfig.makeApiClient(NetworkingV1Api);
const metricsClient = new Metrics(kubeconfig);

const stopProject = createStopper({ coreV1Api });
startReaper(stopProject);
startHealthMonitor(coreV1Api);

// Updated utility function to handle multi-document YAML files
const readAndParseKubeYaml = (filePath: string, substitutions: Record<string, string>): Array<any> => {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const docs = yaml.parseAllDocuments(fileContent).map((doc) => {
        let docString = doc.toString();
        for (const [placeholder, value] of Object.entries(substitutions)) {
            const regex = new RegExp(placeholder, 'g');
            docString = docString.replace(regex, value);
        }
        console.log(docString);
        return yaml.parse(docString);
    });
    return docs;
};

app.post("/start", requireAuth, rateLimit, async (req, res) => {
    const { replId } = req.body;

    if (!replId) {
        res.status(400).send({ message: "Bad request" });
        return;
    }

    const project = getProject(replId);
    if (!project) {
        res.status(404).send({ message: "Project not found" });
        return;
    }
    if (project.ownerId !== req.userId) {
        res.status(403).send({ message: "You do not own this project" });
        return;
    }

    try {
        const namespace = await ensureNamespace(coreV1Api, replId);
        const kubeManifests = readAndParseKubeYaml(path.join(__dirname, "../service.yaml"), {
            service_name: replId,
            owner_id_placeholder: project.ownerId,
            ws_domain_placeholder: WS_DOMAIN,
            app_domain_placeholder: APP_DOMAIN,
        });
        for (const manifest of kubeManifests) {
            switch (manifest.kind) {
                case "Deployment":
                    await withRetry(() => appsV1Api.createNamespacedDeployment(namespace, manifest));
                    break;
                case "Service":
                    await withRetry(() => coreV1Api.createNamespacedService(namespace, manifest));
                    break;
                case "Ingress":
                    await withRetry(() => networkingV1Api.createNamespacedIngress(namespace, manifest));
                    break;
                case "NetworkPolicy":
                    await withRetry(() => networkingV1Api.createNamespacedNetworkPolicy(namespace, manifest));
                    break;
                default:
                    console.log(`Unsupported kind: ${manifest.kind}`);
            }
        }

        // Kubernetes accepts the Deployment regardless of whether any node
        // can actually run it - check for that before reporting success, so
        // we don't tell the user their pod started when it never will.
        const schedulability = await checkPodSchedulable(coreV1Api, replId);
        if (!schedulability.schedulable) {
            console.warn(`[start] ${replId} is unschedulable (${schedulability.reason}), rolling back`);
            await deleteProjectNamespace(coreV1Api, replId).catch((err) =>
                console.error(`[start] failed to roll back namespace for ${replId}`, err)
            );
            res.status(503)
                .set("Retry-After", "30")
                .send({
                    message: `Cluster doesn't have capacity for this project right now (${schedulability.reason}). Please try again shortly.`,
                });
            return;
        }

        markStarted(replId);
        res.status(200).send({ message: "Resources created successfully" });
    } catch (error) {
        console.error("Failed to create resources", error);
        const { status, message } = translateK8sError(error);
        res.status(status).send({ message });
    }
});

app.post("/stop", requireAuth, async (req, res) => {
    const { replId } = req.body;

    if (!replId) {
        res.status(400).send({ message: "Bad request" });
        return;
    }

    const project = getProject(replId);
    if (!project) {
        res.status(404).send({ message: "Project not found" });
        return;
    }
    if (project.ownerId !== req.userId) {
        res.status(403).send({ message: "You do not own this project" });
        return;
    }

    try {
        await stopProject(replId);
        res.status(200).send({ message: "Project stopped" });
    } catch (error) {
        console.error(`Failed to stop ${replId}`, error);
        res.status(500).send({ message: "Failed to fully tear down resources" });
    }
});

// Cluster-wide operational view. Not ownership-scoped (there's no admin/role
// concept in this project) - any authenticated caller sees every project.
// Fine for a portfolio-scale deployment; a real multi-tenant deployment
// would want this restricted to an admin role.
app.get("/status", requireAuth, async (req, res) => {
    const active = getStartedProjects();
    const unhealthy = active.filter((p) => p.healthStatus === "unhealthy");

    const projects = await Promise.all(
        active.map(async (p) => ({
            replId: p.replId,
            ownerId: p.ownerId,
            healthStatus: p.healthStatus,
            restartCount: p.restartCount,
            unhealthyReason: p.unhealthyReason,
            lastActiveAt: p.lastActiveAt,
            resourceUsage: await getPodResourceUsage(metricsClient, p.replId),
        }))
    );

    res.json({
        totalActivePods: active.length,
        unhealthyCount: unhealthy.length,
        projects,
        recentAutoTeardowns: getRecentAutoTeardowns(),
        recentAlerts: getRecentAlerts(),
    });
});

// Ownership-scoped single-project view, for the frontend to poll (e.g. to
// show "this project's pod is unhealthy") without seeing every other
// project's data the way /status does.
app.get("/projects/:replId/status", requireAuth, async (req, res) => {
    const { replId } = req.params;
    const project = getProject(replId);
    if (!project) {
        res.status(404).send({ message: "Project not found" });
        return;
    }
    if (project.ownerId !== req.userId) {
        res.status(403).send({ message: "You do not own this project" });
        return;
    }

    res.json({
        replId: project.replId,
        status: project.status,
        healthStatus: project.healthStatus,
        restartCount: project.restartCount,
        unhealthyReason: project.unhealthyReason,
        lastActiveAt: project.lastActiveAt,
    });
});

const port = process.env.PORT || 3002;
app.listen(port, () => {
    console.log(`Listening on port: ${port}`);
});
