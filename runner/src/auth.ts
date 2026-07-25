import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable is required");
}

export interface TokenPayload {
    userId: string;
}

// Verify-only: tokens are minted by init-service's /auth/session and must be
// signed with the same JWT_SECRET (injected into this pod via the
// sandbox-secrets k8s Secret) for this to accept them.
export function verifyToken(token: string): TokenPayload {
    return jwt.verify(token, JWT_SECRET as string) as TokenPayload;
}
