export const REPL_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;

export function isValidReplId(replId: unknown): replId is string {
    return typeof replId === "string" && REPL_ID_PATTERN.test(replId);
}
