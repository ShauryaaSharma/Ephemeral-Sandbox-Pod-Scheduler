import dotenv from "dotenv"
dotenv.config()
import express from "express";
import { createServer } from "http";
import fs from "fs";
import { initWs, terminalManager, getLastActivityAt, flushPendingS3Writes } from "./ws";
import cors from "cors";
import { autoRunProject } from "./autorun";
import { syncWorkspaceToS3, withTimeout } from "./sync";
import { isValidInternalToken } from "./internalAuth";
import { ALLOWED_ORIGINS } from "./corsOrigins";
import { WORKSPACE_DIR } from "./fs";

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (!INTERNAL_API_TOKEN) {
  throw new Error("INTERNAL_API_TOKEN environment variable is required");
}

// Node terminates the process on an unhandled promise rejection by default -
// found the hard way (an unguarded fetchDir() call in ws.ts crashed the
// entire pod, killing every session in it, the moment /workspace had any
// issue). Every known async socket handler is now wrapped in try/catch, but
// this is the last line of defense against the next one that isn't: log and
// keep the pod running rather than take down every other session over one
// bad request.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] swallowed to avoid crashing the pod:", reason);
});

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());
const httpServer = createServer(app);

initWs(httpServer);

// Internal endpoints, called by orchestrator-simple (not the browser) - but
// reachable at the same public ingress host as the rest of this app, so they
// require this shared x-internal-token header (see README "Lifecycle" trade-off
// note). The env whitelist in pty.ts/shellEnv.ts keeps this out of the user's
// own terminal.
const SYNC_TIMEOUT_MS = 8000;

function requireInternalToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!isValidInternalToken(req.headers["x-internal-token"], INTERNAL_API_TOKEN as string)) {
    res.status(401).send({ message: "Invalid or missing internal token" });
    return;
  }
  next();
}

// Unauthenticated and return no data (unlike /health below), so they're
// safe for the kubelet to probe without the per-pod internal token - the
// kubelet's stable probe API can't send custom headers anyway.
let serverListening = false;

app.get("/healthz", (req, res) => {
  res.sendStatus(200);
});

app.get("/readyz", (req, res) => {
  if (serverListening && fs.existsSync(WORKSPACE_DIR)) {
    res.sendStatus(200);
  } else {
    res.sendStatus(503);
  }
});

app.get("/health", requireInternalToken, (req, res) => {
  res.json({
    status: "ok",
    replId: process.env.REPL_ID ?? "unknown",
    lastActivityAt: getLastActivityAt(),
  });
});

app.post("/shutdown", requireInternalToken, async (req, res) => {
  console.log("[shutdown] received /shutdown request, syncing workspace to S3");
  try {
    // Cancel any pending debounced per-file writes first - syncWorkspaceToS3
    // below re-uploads every file fresh from disk anyway, but this avoids
    // leaving timers to fire after the process has moved on.
    await flushPendingS3Writes();
    await withTimeout(syncWorkspaceToS3(process.env.REPL_ID ?? "unknown"), SYNC_TIMEOUT_MS);
    console.log("[shutdown] final sync complete");
    res.status(200).send({ message: "synced" });
  } catch (err) {
    console.error("[shutdown] final sync failed or timed out", err);
    res.status(500).send({ message: "sync failed or timed out" });
  }
});

// Safety net for when a pod is torn down without the orchestrator's /shutdown
// call landing first (e.g. `kubectl delete pod` directly, or /stop's HTTP
// call failing) - Kubernetes sends SIGTERM before SIGKILL, so this is a last
// chance to flush /workspace to S3 within the pod's termination grace period.
process.on("SIGTERM", async () => {
  console.log("[shutdown] received SIGTERM, syncing workspace to S3 before exit");
  try {
    await flushPendingS3Writes();
    await withTimeout(syncWorkspaceToS3(process.env.REPL_ID ?? "unknown"), SYNC_TIMEOUT_MS);
    console.log("[shutdown] final sync complete");
  } catch (err) {
    console.error("[shutdown] final sync failed or timed out", err);
  }
  process.exit(0);
});

const port = process.env.PORT || 3001;
httpServer.listen(port, () => {
  console.log(`listening on *:${port}`);
  serverListening = true;
});

// Fire-and-forget: don't block server startup on install/start commands.
// REPL_ID is populated by the orchestrator via the same service_name
// substitution used for the rest of service.yaml (see orchestrator-simple/service.yaml).
autoRunProject(terminalManager, process.env.REPL_ID ?? "unknown").catch((err) => {
  console.error("[autorun] unexpected error", err);
});
