import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, createHash } from "crypto";
import jwt from "jsonwebtoken";
import { Request, Response, NextFunction } from "express";

// auth.ts reads JWT_PUBLIC_KEY (and optionally JWT_PUBLIC_KEY_PREVIOUS) at
// module-load time, so a real key pair has to be generated and set before
// it's first imported - a dynamic import after setup, rather than a static
// one, guarantees that order. This service only ever verifies, so tokens
// are minted here directly with jsonwebtoken + the matching private key,
// standing in for what init-service's own signToken would produce.
function generateKeyPair() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    return {
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
}

const currentKey = generateKeyPair();
const previousKey = generateKeyPair();
process.env.JWT_PUBLIC_KEY = currentKey.publicKey;
process.env.JWT_PUBLIC_KEY_PREVIOUS = previousKey.publicKey;

const { verifyToken, requireAuth } = await import("./auth");

function sign(privateKeyPem: string, publicKeyPem: string, userId: string): string {
    const kid = createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 8);
    return jwt.sign({ userId }, privateKeyPem, {
        algorithm: "ES256",
        keyid: kid,
        issuer: "ephemeral-sandbox-init-service",
        audience: "ephemeral-sandbox",
    });
}

function fakeReqRes(authHeader?: string) {
    const req = { headers: { authorization: authHeader } } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    return { req, res, next };
}

describe("verifyToken", () => {
    it("verifies a token signed with the current key", () => {
        const token = sign(currentKey.privateKey, currentKey.publicKey, "user-1");
        expect(verifyToken(token).userId).toBe("user-1");
    });

    it("verifies a token signed with the previous key during rotation", () => {
        const token = sign(previousKey.privateKey, previousKey.publicKey, "user-2");
        expect(verifyToken(token).userId).toBe("user-2");
    });

    it("rejects a token signed with neither known key", () => {
        const rogueKey = generateKeyPair();
        const token = sign(rogueKey.privateKey, rogueKey.publicKey, "user-3");
        expect(() => verifyToken(token)).toThrow();
    });

    it("rejects an algorithm-confusion forgery (HS256 using the public key as an HMAC secret)", () => {
        const forged = jwt.sign({ userId: "attacker" }, currentKey.publicKey, {
            algorithm: "HS256",
            issuer: "ephemeral-sandbox-init-service",
            audience: "ephemeral-sandbox",
        });
        expect(() => verifyToken(forged)).toThrow();
    });
});

describe("requireAuth", () => {
    it("rejects a missing bearer token with 401", () => {
        const { req, res, next } = fakeReqRes(undefined);
        requireAuth(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it("accepts a valid bearer token and sets req.userId", () => {
        const token = sign(currentKey.privateKey, currentKey.publicKey, "user-4");
        const { req, res, next } = fakeReqRes(`Bearer ${token}`);
        requireAuth(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect((req as unknown as { userId: string }).userId).toBe("user-4");
    });
});
