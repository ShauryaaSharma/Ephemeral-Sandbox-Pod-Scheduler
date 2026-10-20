// Env passed to every shell/process spawned inside a user's pod (terminal
// sessions and the autorun process, both via TerminalManager.createPty - see
// pty.ts). A sandbox pod's whole process.env includes AWS credentials,
// JWT_PUBLIC_KEY, OWNER_ID, etc. - none of that belongs in a shell a
// malicious user fully controls, so only this fixed/whitelisted set is
// passed through instead of the real process.env.
const PASSTHROUGH_KEYS = ["PATH", "LANG"] as const;

export function buildShellEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const env: Record<string, string> = {
        HOME: "/workspace",
        TERM: "xterm",
        PORT: "3000",
    };
    for (const key of PASSTHROUGH_KEYS) {
        const value = source[key];
        if (value !== undefined) env[key] = value;
    }
    return env;
}
