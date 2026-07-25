import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable is required");
}

export interface TokenPayload {
    userId: string;
}

// Anonymous, device-bound identity: there's no login/password anywhere in
// this project. A token just proves "the same browser that created replId X
// is asking again" - enough to gate ownership, not a real identity system.
export function signToken(userId: string): string {
    return jwt.sign({ userId }, JWT_SECRET as string, { expiresIn: "30d" });
}

export function verifyToken(token: string): TokenPayload {
    return jwt.verify(token, JWT_SECRET as string) as TokenPayload;
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
