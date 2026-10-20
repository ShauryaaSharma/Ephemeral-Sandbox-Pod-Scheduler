import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";

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

// Verify-only here: tokens are minted by init-service's /auth/session with
// JWT_PRIVATE_KEY, which this service never has access to - only the public
// key needed to verify them.
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
