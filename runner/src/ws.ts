import { Server, Socket } from "socket.io";
import { Server as HttpServer } from "http";
import { saveToS3 } from "./aws";
import path from "path";
import { fetchDir, fetchFileContent, saveFile } from "./fs";
import { TerminalManager } from "./pty";
import { verifyToken } from "./auth";

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
            // Should restrict this more!
            origin: "*",
            methods: ["GET", "POST"],
        },
    });

    io.on("connection", async (socket) => {
        const host = socket.handshake.headers.host;
        console.log(`host is ${host}`);
        // Split the host by '.' and take the first part as replId
        const replId = host?.split('.')[0];

        if (!replId) {
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
                rootContent: await fetchDir("/workspace", "")
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
    });

    socket.on("fetchDir", async (dir: string, callback) => {
        touch();
        try {
            const dirPath = `/workspace/${dir}`;
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
            const fullPath = `/workspace/${filePath}`;
            const data = await fetchFileContent(fullPath);
            callback(data);
        } catch (err) {
            console.error(`fetchContent failed for ${replId} (${filePath}):`, err);
            callback("");
        }
    });

    // TODO: contents should be diff, not full file
    // Should be validated for size
    // Should be throttled before updating S3 (or use an S3 mount)
    socket.on("updateContent", async ({ path: filePath, content }: { path: string, content: string }) => {
        touch();
        try {
            const fullPath = `/workspace/${filePath}`;
            await saveFile(fullPath, content);
            await saveToS3(`code/${replId}`, filePath, content);
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