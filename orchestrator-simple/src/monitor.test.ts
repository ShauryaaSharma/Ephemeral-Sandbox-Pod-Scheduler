import { describe, it, expect } from "vitest";
import { CoreV1Api, Metrics } from "@kubernetes/client-node";
import { checkPodHealth, getPodResourceUsage } from "./monitor";

function fakeCoreV1Api(pods: unknown[]): CoreV1Api {
    return {
        listNamespacedPod: async () => ({ body: { items: pods } }),
    } as unknown as CoreV1Api;
}

function podWith(containerStatus: Record<string, unknown>) {
    return { status: { phase: "Running", containerStatuses: [{ name: "runner", ...containerStatus }] } };
}

describe("checkPodHealth", () => {
    it("classifies a missing pod", async () => {
        const health = await checkPodHealth(fakeCoreV1Api([]), "repl-missing");
        expect(health).toEqual({ found: false, restartCount: 0, crashLooping: false, oomKilled: false });
    });

    it("classifies a healthy pod", async () => {
        const api = fakeCoreV1Api([podWith({ restartCount: 0 })]);
        const health = await checkPodHealth(api, "repl-healthy");
        expect(health.found).toBe(true);
        expect(health.crashLooping).toBe(false);
        expect(health.oomKilled).toBe(false);
    });

    it("classifies a CrashLoopBackOff pod", async () => {
        const api = fakeCoreV1Api([podWith({ restartCount: 2, state: { waiting: { reason: "CrashLoopBackOff" } } })]);
        const health = await checkPodHealth(api, "repl-crashloop");
        expect(health.crashLooping).toBe(true);
        expect(health.oomKilled).toBe(false);
        expect(health.reason).toBe("CrashLoopBackOff");
    });

    it("classifies crash-looping via restart-count threshold even without the CrashLoopBackOff reason yet", async () => {
        const api = fakeCoreV1Api([podWith({ restartCount: 5 })]); // default CRASH_RESTART_THRESHOLD
        const health = await checkPodHealth(api, "repl-threshold");
        expect(health.crashLooping).toBe(true);
    });

    it("classifies an OOMKilled pod separately from crash-looping", async () => {
        const api = fakeCoreV1Api([
            podWith({ restartCount: 1, lastState: { terminated: { reason: "OOMKilled" } } }),
        ]);
        const health = await checkPodHealth(api, "repl-oom");
        expect(health.oomKilled).toBe(true);
        expect(health.crashLooping).toBe(false);
        expect(health.reason).toBe("OOMKilled");
    });
});

describe("getPodResourceUsage", () => {
    it("returns usage when metrics-server has data", async () => {
        const metricsClient = {
            getPodMetrics: async () => ({
                items: [{ containers: [{ name: "runner", usage: { cpu: "12m", memory: "34Mi" } }] }],
            }),
        } as unknown as Metrics;

        expect(await getPodResourceUsage(metricsClient, "repl-1")).toEqual({ cpu: "12m", memory: "34Mi" });
    });

    it("fails closed to null when the metrics API throws (e.g. no metrics-server)", async () => {
        const metricsClient = {
            getPodMetrics: async () => {
                throw new Error("metrics-server not installed");
            },
        } as unknown as Metrics;

        expect(await getPodResourceUsage(metricsClient, "repl-1")).toBeNull();
    });

    it("returns null when no pod metrics are found", async () => {
        const metricsClient = { getPodMetrics: async () => ({ items: [] }) } as unknown as Metrics;
        expect(await getPodResourceUsage(metricsClient, "repl-1")).toBeNull();
    });
});
