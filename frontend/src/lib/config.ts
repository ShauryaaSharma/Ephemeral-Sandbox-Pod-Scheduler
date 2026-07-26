// Centralizes every deployment-configurable endpoint the frontend talks to.
// Without this, the app only ever worked from localhost - init-service and
// orchestrator-simple were hardcoded, and the per-project subdomains always
// assumed plain HTTP/WS, so enabling TLS backend-side (Priority 6) did
// nothing for actual browser connections.

// init-service and orchestrator-simple are two ordinary long-running
// services you deploy yourself, wherever that ends up being - unlike the
// per-project subdomains below, there's no fixed pattern to their address,
// so these are full base URLs (protocol + host + port), not just a domain.
export const INIT_SERVICE_URL = import.meta.env.VITE_INIT_SERVICE_URL ?? "http://localhost:3001";
export const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL ?? "http://localhost:3002";

const WS_DOMAIN = import.meta.env.VITE_WS_DOMAIN ?? "peetcode.com";
const APP_DOMAIN = import.meta.env.VITE_APP_DOMAIN ?? "autogpt-cloud.com";

// One flag for both, since both project domains share the same cluster-wide
// wildcard certificate (see README "TLS via cert-manager") - there's no
// scenario where one is TLS-enabled and the other isn't.
const USE_TLS = import.meta.env.VITE_USE_TLS === "true";

export function socketUrl(replId: string): string {
    return `${USE_TLS ? "wss" : "ws"}://${replId}.${WS_DOMAIN}`;
}

export function outputUrl(replId: string): string {
    return `${USE_TLS ? "https" : "http"}://${replId}.${APP_DOMAIN}`;
}
