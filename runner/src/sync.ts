import fs from "fs/promises";
import path from "path";
import { saveToS3 } from "./aws";

const WORKSPACE_DIR = "/workspace";

// Individual edits already saveToS3 as they happen (see ws.ts's "updateContent"
// handler), so this isn't recovering a backlog of buffered writes - it's a
// belt-and-suspenders re-upload of whatever is actually on disk, covering any
// edit whose S3 write raced with (or landed just before) pod teardown.
async function walkAndSync(dir: string, relDir: string, replId: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = `${relDir}/${entry.name}`;
        if (entry.isDirectory()) {
            await walkAndSync(fullPath, relPath, replId);
        } else if (entry.isFile()) {
            const content = await fs.readFile(fullPath, "utf8");
            await saveToS3(`code/${replId}`, relPath, content);
        }
    }
}

// workspaceDir defaults to /workspace (the volume mounted inside every pod);
// only overridden in tests, since /workspace doesn't exist outside a pod.
export async function syncWorkspaceToS3(replId: string, workspaceDir: string = WORKSPACE_DIR): Promise<void> {
    await walkAndSync(workspaceDir, "", replId);
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        }),
    ]);
}
