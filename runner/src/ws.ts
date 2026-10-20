import { Server, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { saveToS3 } from "./aws";
import { fetchDir, fetchFileContent, saveFile, resolveInWorkspace, WORKSPACE_DIR } from "./fs";
import { TerminalManager } from "./pty";
import { verifyToken } from "./auth";
import { ALLOWED_ORIGINS } from "./corsOrigins";
import { S3WriteDebouncer } from "./s3WriteDebouncer";

// Default 1MB - env-configurable since some projects legitimately have
// larger generated/vendored files.
const MAX_UPDATE_CONTENT_BYTES = Number(process.env.MAX_FILE_UPDATE_BYTES) || 1024 * 1024;

// Default 1500ms trailing debounce - env-configurable. Coalesces a burst of
// edits (e.g. every keystroke) into one S3 write per file instead of one
// PUT per edit; the local disk write in updateContent below is never
// debounced, only the S3 upload.
const S3_WRITE_DEBOUNCE_MS = Number(process.env.S3_WRITE_DEBOUNCE_MS) || 1500;
const s3WriteDebouncer = new S3WriteDebouncer(saveToS3, S3_WRITE_DEBOUNCE_MS);

// Called from index.ts on /shutdown and SIGTERM, so a save made just before
// either doesn't get lost waiting out the debounce window.
export function flushPendingS3Writes(): Promise<void> {
    return s3WriteDebouncer.flush();
}

// Shared with autorun.ts so the auto-started project process lives in the
// same registry as user-opened terminal sessions.
export const terminalManager = new TerminalManager();

// In-memory only - read by the orchestrator's idle-timeout reaper via
// GET /health. Reset to "now" on connect and on every meaningful action, so
// an open-but-idle browser tab still counts as idle for teardown purposes.
let lastActivityAt = Date.now();

export function getLastActivityAt(): number {
    return lastActivityAt;
}

function touch() {
    lastActivityAt = Date.now();
}

export function initWs(httpServer: HttpServer) {
    const io = new Server(httpServer, {
        cors: {
            // Every project's subdomain is dynamic (<replId>.<WS_DOMAIN>), but
            // the browser origin actually making this connection is always the
            // one configured frontend origin - not a per-project value.
            origin: ALLOWED_ORIGINS,
            methods: ["GET", "POST"],
        },
    });

    io.on("connection", async (socket) => {
        // Trusting the Host header to derive replId let a client that could
        // reach this pod directly (bypassing the ingress's subdomain
        // routing) claim to be whatever project it wanted, since the header
        // is entirely client-controlled. Every pod only ever serves exactly
        // one project - REPL_ID is injected by the orchestrator at
        // pod-creation time (the same value used for /health, autorun,
        // etc.), so it's the trustworthy source for this.
        const replId = process.env.REPL_ID;

        if (!replId) {
            console.error("REPL_ID environment variable is not set - rejecting connection");
            socket.disconnect();
            terminalManager.clear(socket.id);
            return;
        }

        // OWNER_ID is injected by the orchestrator at pod-creation time, from
        // the ownership row it already checked in POST /start - so this pod
        // only ever needs to compare against its own env, no DB/network
        // lookup required. Reject unless the caller presents a valid token
        // for the user that actually owns this project.
        const expectedOwnerId = process.env.OWNER_ID;
        const token = socket.handshake.auth?.token as string | undefined;
        let userId: string | undefined;
        try {
            if (!token) throw new Error("missing token");
            userId = verifyToken(token).userId;
        } catch {
            console.log("rejecting socket connection: missing or invalid token");
            socket.disconnect();
            return;
        }
        if (!expectedOwnerId || userId !== expectedOwnerId) {
            console.log(`rejecting socket connection: ${userId} does not own this pod`);
            socket.disconnect();
            return;
        }

        touch();
        try {
            socket.emit("loaded", {
                rootContent: await fetchDir(WORKSPACE_DIR, "")
            });
        } catch (err) {
            // Any async handler in this file rejecting used to crash the
            // whole process (Node terminates on unhandled rejections) -
            // taking down every other session in this pod over one bad file
            // op. /workspace should always exist by the time a socket
            // connects (the init container populates it before this
            // container even starts), but there's no good reason to let a
            // filesystem hiccup here kill the pod instead of just this load.
            console.error(`failed to load workspace contents for ${replId}:`, err);
            socket.emit("loaded", { rootContent: [] });
        }

        initHandlers(socket, replId);
    });
}

function initHandlers(socket: Socket, replId: string) {

    socket.on("disconnect", () => {
        console.log("user disconnected");
        // Each socket owns exactly one terminal, keyed by its own socket.id -
        // without this the underlying PTY process outlived the connection.
        terminalManager.clear(socket.id);
        // Don't leave a debounced S3 write hanging past the session that
        // made it.
        flushPendingS3Writes().catch((err) => console.error(`flush on disconnect failed for ${replId}:`, err));
    });

    socket.on("fetchDir", async (dir: string, callback) => {
        touch();
        try {
            const dirPath = resolveInWorkspace(dir);
            const contents = await fetchDir(dirPath, dir);
            callback(contents);
        } catch (err) {
            console.error(`fetchDir failed for ${replId} (${dir}):`, err);
            callback([]);
        }
    });

    socket.on("fetchContent", async ({ path: filePath }: { path: string }, callback) => {
        touch();
        try {
            const fullPath = resolveInWorkspace(filePath);
            const data = await fetchFileContent(fullPath);
            callback(data);
        } catch (err) {
            console.error(`fetchContent failed for ${replId} (${filePath}):`, err);
            callback("");
        }
    });

    // Sends the whole file on every edit, not a diff - see README Roadmap
    // ("send diffs instead of full files").
    socket.on("updateContent", async ({ path: filePath, content }: { path: string, content: string }) => {
        touch();
        try {
            if (typeof content !== "string" || Buffer.byteLength(content, "utf-8") > MAX_UPDATE_CONTENT_BYTES) {
                console.warn(`updateContent rejected for ${replId} (${filePath}): payload too large`);
                return;
            }
            const fullPath = resolveInWorkspace(filePath);
            await saveFile(fullPath, content);
            // Built from the same validated/normalized path as the local
            // write above, not the raw client-supplied filePath, so a
            // traversal attempt can't produce a different (and possibly
            // unsafe) S3 key than the file it actually wrote to. The disk
            // write above is immediate; only the S3 upload is debounced
            // (see s3WriteDebouncer.ts) so a burst of edits doesn't fire one
            // S3 PUT per keystroke.
            const safeRelativePath = "/" + fullPath.slice(WORKSPACE_DIR.length).replace(/^\/+/, "");
            s3WriteDebouncer.schedule(`code/${replId}`, safeRelativePath, content);
        } catch (err) {
            // No ack callback on this event today, so there's nothing to
            // report back to the client - but the process must survive a
            // bad path or a transient S3 error regardless.
            console.error(`updateContent failed for ${replId} (${filePath}):`, err);
        }
    });

    socket.on("requestTerminal", async () => {
        touch();
        try {
            terminalManager.createPty(socket.id, replId, (data, id) => {
                socket.emit('terminal', {
                    data: Buffer.from(data,"utf-8")
                });
            });
        } catch (err) {
            console.error(`requestTerminal failed for ${replId}:`, err);
        }
    });

    socket.on("terminalData", async ({ data }: { data: string, terminalId: number }) => {
        touch();
        try {
            terminalManager.write(socket.id, data);
        } catch (err) {
            console.error(`terminalData write failed for ${replId}:`, err);
        }
    });

}