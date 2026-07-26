import axios from "axios";
import { INIT_SERVICE_URL } from "./config";

const TOKEN_KEY = "sandbox_auth_token";

let pendingSession: Promise<string> | null = null;

// Anonymous, device-bound identity: there's no login/password anywhere in
// this project. The first call here mints a token (cached in localStorage)
// that scopes "which projects did this browser create" for ownership checks
// on /project, /start, and the runner's socket connection.
export async function getAuthToken(): Promise<string> {
    const existing = localStorage.getItem(TOKEN_KEY);
    if (existing) {
        return existing;
    }
    if (!pendingSession) {
        pendingSession = axios.post(`${INIT_SERVICE_URL}/auth/session`).then(({ data }) => {
            localStorage.setItem(TOKEN_KEY, data.token);
            return data.token as string;
        });
    }
    return pendingSession;
}

export async function authHeaders(): Promise<{ Authorization: string }> {
    const token = await getAuthToken();
    return { Authorization: `Bearer ${token}` };
}
