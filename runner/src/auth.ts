import jwt from "jsonwebtoken";

// A .env value can't contain a literal newline, so PEM keys are stored with
// escaped "\n" sequences there - this normalizes either form back to real
// newlines (a k8s Secret value, which can hold real newlines directly, is a
// no-op here).
function normalizePem(pem: string): string {
    return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

const JWT_PUBLIC_KEY_RAW = process.env.JWT_PUBLIC_KEY;
if (!JWT_PUBLIC_KEY_RAW) {
    throw new Error("JWT_PUBLIC_KEY environment variable is required");
}
const JWT_PUBLIC_KEY = normalizePem(JWT_PUBLIC_KEY_RAW);

export interface TokenPayload {
    userId: string;
}

// Verify-only: tokens are minted by init-service's /auth/session with
// JWT_PRIVATE_KEY, which this pod never has access to - only the public key
// (injected via the sandbox-secrets k8s Secret) needed to verify them.
export function verifyToken(token: string): TokenPayload {
    return jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ["RS256"] }) as TokenPayload;
}
