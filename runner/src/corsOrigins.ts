const DEFAULT_DEV_ORIGIN = "http://localhost:5173";

// Pure - kept separate from the env/NODE_ENV read below so it's testable
// without touching process.env. ALLOWED_ORIGINS is comma-separated since a
// deployment may serve the frontend from more than one origin (e.g. a
// preview + production domain).
export function parseAllowedOrigins(rawValue: string | undefined, nodeEnv: string | undefined): string[] {
    const trimmed = rawValue?.trim();
    if (trimmed) {
        return trimmed
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean);
    }
    if (nodeEnv === "production") {
        throw new Error("ALLOWED_ORIGINS environment variable is required in production");
    }
    return [DEFAULT_DEV_ORIGIN];
}

export const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS, process.env.NODE_ENV);
