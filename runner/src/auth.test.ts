import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createHash } from "crypto";
import jwt from "jsonwebtoken";

// auth.ts reads JWT_PUBLIC_KEY at module-load time, so a real key pair has
// to be generated and set before it's first imported - a dynamic import
// after setup, rather than a static one, guarantees that order.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
process.env.JWT_PUBLIC_KEY = publicKeyPem;

const { verifyToken } = await import("./auth");

function sign(userId: string): string {
    const kid = createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 8);
    return jwt.sign({ userId }, privateKeyPem, {
        algorithm: "ES256",
        keyid: kid,
        issuer: "ephemeral-sandbox-init-service",
        audience: "ephemeral-sandbox",
    });
}

describe("verifyToken", () => {
    it("verifies a validly signed token", () => {
        expect(verifyToken(sign("user-1")).userId).toBe("user-1");
    });

    it("rejects a token signed with an unrelated key", () => {
        const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
        const token = jwt.sign({ userId: "user-2" }, other.privateKey, {
            algorithm: "ES256",
            issuer: "ephemeral-sandbox-init-service",
            audience: "ephemeral-sandbox",
        });
        expect(() => verifyToken(token)).toThrow();
    });

    it("rejects a token with the wrong audience", () => {
        const token = jwt.sign({ userId: "user-3" }, privateKeyPem, {
            algorithm: "ES256",
            issuer: "ephemeral-sandbox-init-service",
            audience: "some-other-audience",
        });
        expect(() => verifyToken(token)).toThrow();
    });
});
