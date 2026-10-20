const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const configured = process.env.LOG_LEVEL as Level | undefined;
const threshold = LEVELS.indexOf(configured && LEVELS.includes(configured) ? configured : "info");

function log(level: Level, ...args: unknown[]): void {
    if (LEVELS.indexOf(level) < threshold) return;
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(...args);
}

export const logger = {
    debug: (...args: unknown[]) => log("debug", ...args),
    info: (...args: unknown[]) => log("info", ...args),
    warn: (...args: unknown[]) => log("warn", ...args),
    error: (...args: unknown[]) => log("error", ...args),
};
