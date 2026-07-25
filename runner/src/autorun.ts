import fs from "fs/promises";
import path from "path";
import { TerminalManager } from "./pty";

const WORKSPACE_DIR = "/workspace";
const AUTORUN_SESSION_ID = "__autorun__";

async function pathExists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

async function readProcfileCommand(workspaceDir: string): Promise<string | null> {
    const procfilePath = path.join(workspaceDir, "Procfile");
    if (!(await pathExists(procfilePath))) return null;

    const contents = await fs.readFile(procfilePath, "utf8");
    const match = contents.match(/^\s*web\s*:\s*(.+)$/m);
    return match ? match[1].trim() : null;
}

async function detectNodeCommand(workspaceDir: string): Promise<string | null> {
    const pkgPath = path.join(workspaceDir, "package.json");
    if (!(await pathExists(pkgPath))) return null;

    let runScript = "start";
    try {
        const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
        if (pkg?.scripts?.dev) {
            runScript = "dev";
        } else if (!pkg?.scripts?.start) {
            console.log("[autorun] package.json has no dev/start script, installing dependencies only");
            return "npm install";
        }
    } catch (err) {
        console.warn("[autorun] failed to parse package.json, falling back to npm start", err);
    }

    return `npm install && npm run ${runScript}`;
}

async function detectPythonCommand(workspaceDir: string): Promise<string | null> {
    const reqPath = path.join(workspaceDir, "requirements.txt");
    if (!(await pathExists(reqPath))) return null;

    const entrypoints = ["app.py", "main.py", "server.py"];
    for (const file of entrypoints) {
        if (await pathExists(path.join(workspaceDir, file))) {
            return `pip install -r requirements.txt && python ${file}`;
        }
    }

    console.log("[autorun] requirements.txt found but no app.py/main.py/server.py, installing dependencies only");
    return "pip install -r requirements.txt";
}

async function detectStartCommand(workspaceDir: string): Promise<string | null> {
    // A Procfile ("web: <cmd>") is the configurable escape hatch - it wins
    // over the node/python heuristics below for projects that need something
    // more specific than "npm start" / "python main.py".
    const procfileCommand = await readProcfileCommand(workspaceDir);
    if (procfileCommand) return procfileCommand;

    return (await detectNodeCommand(workspaceDir)) ?? (await detectPythonCommand(workspaceDir));
}

/**
 * Best-effort, non-blocking: detects the project type in /workspace and runs
 * its install+start command in a dedicated background terminal session, so
 * the Output iframe (pod port 3000) has something listening on it without
 * the user typing commands manually. Any failure here is logged and
 * swallowed - it must never take down pod startup - and the user's own
 * terminal session (keyed by their socket id) is a completely independent
 * TerminalManager entry, so they can always intervene manually regardless of
 * how this turns out.
 */
export async function autoRunProject(terminalManager: TerminalManager, replId: string): Promise<void> {
    try {
        if (!(await pathExists(WORKSPACE_DIR))) {
            console.log("[autorun] /workspace not present, skipping (not running inside a pod?)");
            return;
        }

        const command = await detectStartCommand(WORKSPACE_DIR);
        if (!command) {
            console.log("[autorun] no recognizable project type (no package.json/requirements.txt/Procfile), skipping");
            return;
        }

        console.log(`[autorun] detected project type, running: ${command}`);
        const term = terminalManager.createPty(AUTORUN_SESSION_ID, replId, (data) => {
            process.stdout.write(`[autorun:${replId}] ${data}`);
        });
        term.write(`${command}\r`);
    } catch (err) {
        console.error("[autorun] failed to auto-start the project, leaving pod up for manual use", err);
    }
}
