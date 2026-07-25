import dotenv from "dotenv"
dotenv.config()
import express from "express";
import { createServer } from "http";
import { initWs, terminalManager, getLastActivityAt } from "./ws";
import cors from "cors";
import { autoRunProject } from "./autorun";
import { syncWorkspaceToS3, withTimeout } from "./sync";

const app = express();
app.use(cors());
app.use(express.json());
const httpServer = createServer(app);

initWs(httpServer);

// Internal endpoints, called by orchestrator-simple (not the browser). They're
// reachable at the same public ingress host as the rest of this app - see the
// README's "Auth & ownership" trade-off note on why these two aren't token-gated.
const SYNC_TIMEOUT_MS = 8000;

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    replId: process.env.REPL_ID ?? "unknown",
    lastActivityAt: getLastActivityAt(),
  });
});

app.post("/shutdown", async (req, res) => {
  console.log("[shutdown] received /shutdown request, syncing workspace to S3");
  try {
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
});

// Fire-and-forget: don't block server startup on install/start commands.
// REPL_ID is populated by the orchestrator via the same service_name
// substitution used for the rest of service.yaml (see orchestrator-simple/service.yaml).
autoRunProject(terminalManager, process.env.REPL_ID ?? "unknown").catch((err) => {
  console.error("[autorun] unexpected error", err);
});
