/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_WS_DOMAIN?: string;
    readonly VITE_APP_DOMAIN?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
