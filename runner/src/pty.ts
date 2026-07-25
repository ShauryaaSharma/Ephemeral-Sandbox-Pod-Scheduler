//@ts-ignore => someone fix this
import { fork, IPty } from 'node-pty';
import path from "path";

const SHELL = "bash";

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
        let term = fork(SHELL, [], {
            cols: 100,
            name: 'xterm',
            cwd: this.cwd
        });

        term.on('data', (data: string) => onData(data, term.pid));
        this.sessions[id] = {
            terminal: term,
            replId
        };
        // Sessions are keyed by the caller-supplied `id` (e.g. socket.id), not
        // by the OS pid, so cleanup on natural exit must use the same key.
        term.on('exit', () => {
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
