import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";

// A .env value can't contain a literal newline, so PEM keys are stored with
// escaped "\n" sequences there - this normalizes either form back to real
// newlines (a k8s Secret value, which can hold real newlines directly, is a
// no-op here).
function normalizePem(pem: string): string {
    return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

// Pinned, matching init-service's auth.ts exactly - jwt.verify only ever
// tries this one algorithm/issuer/audience, ruling out algorithm-confusion
// forgeries and tokens from anywhere else.
const ALGORITHM = "ES256";
const ISSUER = "ephemeral-sandbox-init-service";
const AUDIENCE = "ephemeral-sandbox";

const JWT_PUBLIC_KEY_RAW = process.env.JWT_PUBLIC_KEY;
if (!JWT_PUBLIC_KEY_RAW) {
    throw new Error("JWT_PUBLIC_KEY environment variable is required");
}
const JWT_PUBLIC_KEY = normalizePem(JWT_PUBLIC_KEY_RAW);

// Optional second key accepted during rotation: after generating a new
// JWT_PRIVATE_KEY/JWT_PUBLIC_KEY pair, set the *old* public key here and the
// new one as JWT_PUBLIC_KEY - tokens already signed with the old private
// key keep verifying (so rotating doesn't log anyone out) until this is
// removed once they've naturally cycled out. See README "Rotating JWT keys".
const JWT_PUBLIC_KEY_PREVIOUS_RAW = process.env.JWT_PUBLIC_KEY_PREVIOUS;
const JWT_PUBLIC_KEY_PREVIOUS = JWT_PUBLIC_KEY_PREVIOUS_RAW ? normalizePem(JWT_PUBLIC_KEY_PREVIOUS_RAW) : undefined;

function keyId(publicKeyPem: string): string {
    return createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 8);
}

const PREVIOUS_KID = JWT_PUBLIC_KEY_PREVIOUS ? keyId(JWT_PUBLIC_KEY_PREVIOUS) : undefined;

export interface TokenPayload {
    userId: string;
}

// Verify-only here: tokens are minted by init-service's /auth/session with
// JWT_PRIVATE_KEY, which this service never has access to - only the public
// key(s) needed to verify them. Picks current vs. previous key by the
// token's own "kid" header (an unsigned peek at the header only - the
// signature is still fully verified below against whichever key that
// points at), rather than trying both and seeing what sticks.
export function verifyToken(token: string): TokenPayload {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded && typeof decoded !== "string" ? decoded.header.kid : undefined;
    const key = kid === PREVIOUS_KID && JWT_PUBLIC_KEY_PREVIOUS ? JWT_PUBLIC_KEY_PREVIOUS : JWT_PUBLIC_KEY;
    return jwt.verify(token, key, {
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
