import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { createHash, createPublicKey } from "crypto";

// A .env value can't contain a literal newline, so PEM keys are stored with
// escaped "\n" sequences there - this normalizes either form back to real
// newlines (a k8s Secret value, which can hold real newlines directly, is a
// no-op here).
function normalizePem(pem: string): string {
    return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

// Pinned everywhere a token is verified (here and in orchestrator-simple/
// runner's auth.ts) to rule out algorithm-confusion attacks - a token
// claiming alg:"none" or alg:"HS256" (which would let anyone forge one
// using the public key as an HMAC secret) is rejected outright, since
// jwt.verify only ever tries the algorithms listed here.
export const ALGORITHM = "ES256";
export const ISSUER = "ephemeral-sandbox-init-service";
export const AUDIENCE = "ephemeral-sandbox";

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

// Identifies which public key a token was signed with, so verifiers holding
// both a current and a previous key (see orchestrator-simple/runner's
// auth.ts) know which one to check against during rotation - derived from
// the key itself, not a manually-tracked version number.
export function keyId(publicKeyPem: string): string {
    return createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 8);
}

export interface TokenPayload {
    userId: string;
}

// Anonymous, device-bound identity: there's no login/password anywhere in
// this project. A token just proves "the same browser that created replId X
// is asking again" - enough to gate ownership, not a real identity system.
//
// No "exp" claim: clearing localStorage already forfeits access to a
// project with no recovery path (see README "Auth & ownership"), so a token
// expiring on top of that would just be one more way to get silently locked
// out, not a real security boundary - this is anonymous, not authenticated,
// identity. Rotating JWT_PRIVATE_KEY (see README "Generating the JWT key
// pair") is the only way an existing token stops working.
export function signToken(userId: string): string {
    return jwt.sign({ userId }, JWT_PRIVATE_KEY, {
        algorithm: ALGORITHM,
        keyid: keyId(JWT_PUBLIC_KEY),
        issuer: ISSUER,
        audience: AUDIENCE,
    });
}

export function verifyToken(token: string): TokenPayload {
    return jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
    }) as TokenPayload;
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
