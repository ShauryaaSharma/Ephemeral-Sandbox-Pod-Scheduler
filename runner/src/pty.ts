import { spawn, IPty } from 'node-pty';
import path from "path";
import { buildShellEnv } from "./shellEnv";

const SHELL = "bash";

// Unset (the default) outside a real pod - plain local dev has no
// privilege to switch uid/gid and shouldn't need to. In the pod, set to
// 1001/1000 (service.yaml) - a different uid than the runner process
// itself (which runs as uid 0 with only CAP_SETUID/CAP_SETGID kept, see
// README "Per-pod internal token & process isolation"), so the user's own
// shell can no longer read the runner's /proc/<pid>/environ: same-uid is
// one of the two ways Linux grants that read, and the runner process no
// longer has the other (CAP_SYS_PTRACE - dropped along with every
// capability except the two needed to make this uid switch happen).
const SHELL_UID = process.env.SANDBOX_SHELL_UID ? Number(process.env.SANDBOX_SHELL_UID) : undefined;
const SHELL_GID = process.env.SANDBOX_SHELL_GID ? Number(process.env.SANDBOX_SHELL_GID) : undefined;

export class TerminalManager {
    private sessions: { [id: string]: {terminal: IPty, replId: string;} } = {};
    private cwd: string;

    // cwd defaults to /workspace (the volume mounted inside every pod); only
    // overridden in tests, since /workspace doesn't exist outside a pod.
    constructor(cwd: string = "/workspace") {
        this.sessions = {};
        this.cwd = cwd;
    }

    createPty(id: string, replId: string, onData: (data: string, id: number) => void) {
        let term = spawn(SHELL, [], {
            cols: 100,
            name: 'xterm',
            cwd: this.cwd,
            // Whitelisted, not the pod's full process.env - see shellEnv.ts.
            // Also covers autorun.ts, which spawns through this same method.
            env: buildShellEnv(),
            // Also covers autorun.ts - see the SHELL_UID/SHELL_GID comment above.
            uid: SHELL_UID,
            gid: SHELL_GID
        });

        term.onData((data: string) => onData(data, term.pid));
        this.sessions[id] = {
            terminal: term,
            replId
        };
        // Sessions are keyed by the caller-supplied `id` (e.g. socket.id), not
        // by the OS pid, so cleanup on natural exit must use the same key.
        term.onExit(() => {
            delete this.sessions[id];
        });
        return term;
    }

    write(terminalId: string, data: string) {
        this.sessions[terminalId]?.terminal.write(data);
    }

    clear(terminalId: string) {
        const session = this.sessions[terminalId];
        if (!session) return;
        session.terminal.kill();
        delete this.sessions[terminalId];
    }

    has(terminalId: string): boolean {
        return terminalId in this.sessions;
    }

    getActiveSessionIds(): string[] {
        return Object.keys(this.sessions);
    }
}
