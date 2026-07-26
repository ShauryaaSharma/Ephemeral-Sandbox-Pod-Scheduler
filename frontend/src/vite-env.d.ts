/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_INIT_SERVICE_URL?: string;
    readonly VITE_ORCHESTRATOR_URL?: string;
    readonly VITE_WS_DOMAIN?: string;
    readonly VITE_APP_DOMAIN?: string;
    readonly VITE_USE_TLS?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
