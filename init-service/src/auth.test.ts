import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync } from "crypto";
import { Request, Response, NextFunction } from "express";

// auth.ts reads JWT_PRIVATE_KEY at module-load time, so a real key pair has
// to be generated and set before it's first imported - a dynamic import
// after setup, rather than a static one, guarantees that order.
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.JWT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const { signToken, verifyToken, requireAuth } = await import("./auth");

function fakeReqRes(authHeader?: string) {
    const req = { headers: { authorization: authHeader } } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn().mockReturnThis() } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    return { req, res, next };
}

describe("signToken / verifyToken", () => {
    it("round-trips a userId", () => {
        const token = signToken("user-123");
        expect(verifyToken(token).userId).toBe("user-123");
    });

    it("rejects a tampered token", () => {
        const token = signToken("user-123");
        const tampered = token.slice(0, -2) + "zz";
        expect(() => verifyToken(tampered)).toThrow();
    });
});

describe("requireAuth", () => {
    it("rejects a missing bearer token with 401", () => {
        const { req, res, next } = fakeReqRes(undefined);
        requireAuth(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects a malformed/invalid token with 401", () => {
        const { req, res, next } = fakeReqRes("Bearer not-a-real-token");
        requireAuth(req, res, next);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it("accepts a valid bearer token and sets req.userId", () => {
        const token = signToken("user-456");
        const { req, res, next } = fakeReqRes(`Bearer ${token}`);
        requireAuth(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
        expect((req as unknown as { userId: string }).userId).toBe("user-456");
    });
});
