import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { createPublicKey } from "crypto";

// A .env value can't contain a literal newline, so PEM keys are stored with
// escaped "\n" sequences there - this normalizes either form back to real
// newlines (a k8s Secret value, which can hold real newlines directly, is a
// no-op here).
function normalizePem(pem: string): string {
    return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

const JWT_PRIVATE_KEY_RAW = process.env.JWT_PRIVATE_KEY;
if (!JWT_PRIVATE_KEY_RAW) {
    throw new Error("JWT_PRIVATE_KEY environment variable is required");
}
const JWT_PRIVATE_KEY = normalizePem(JWT_PRIVATE_KEY_RAW);
// Derived from the private key rather than requiring a separate
// JWT_PUBLIC_KEY env var here too - init-service is the only service that
// ever needs to verify tokens signed with its own key (POST /project's
// requireAuth); orchestrator-simple and runner get JWT_PUBLIC_KEY directly
// and never see this private key at all.
const JWT_PUBLIC_KEY = createPublicKey(JWT_PRIVATE_KEY).export({ type: "spki", format: "pem" }).toString();

export interface TokenPayload {
    userId: string;
}

// Anonymous, device-bound identity: there's no login/password anywhere in
// this project. A token just proves "the same browser that created replId X
// is asking again" - enough to gate ownership, not a real identity system.
export function signToken(userId: string): string {
    return jwt.sign({ userId }, JWT_PRIVATE_KEY, { algorithm: "RS256", expiresIn: "30d" });
}

export function verifyToken(token: string): TokenPayload {
    return jwt.verify(token, JWT_PUBLIC_KEY, { algorithms: ["RS256"] }) as TokenPayload;
}

declare global {
    namespace Express {
        interface Request {
            userId?: string;
        }
    }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) {
        res.status(401).send({ message: "Missing bearer token" });
        return;
    }
    try {
        req.userId = verifyToken(token).userId;
        next();
    } catch {
        res.status(401).send({ message: "Invalid or expired token" });
    }
}
