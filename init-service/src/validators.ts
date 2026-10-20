// Mirrors the template folders actually seeded under base/ (base/node-js,
// base/python - see seed-templates.js). Kept as a literal list rather than
// scanned at runtime: this service's own Docker image doesn't ship the
// base/ folder, only S3/R2 has it (copied there once by seed-templates.js).
export const ALLOWED_LANGUAGES = ["node-js", "python"];

export const REPL_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$/;

export function isValidReplId(replId: unknown): replId is string {
    return typeof replId === "string" && REPL_ID_PATTERN.test(replId);
}

export function isValidLanguage(language: unknown): language is string {
    return typeof language === "string" && ALLOWED_LANGUAGES.includes(language);
}
