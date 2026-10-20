import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";

// derivePodToken reads INTERNAL_API_MASTER_KEY at module-load time (and
// throws if it's missing), so it has to be set before the module is first
// imported - a dynamic import after setting it, rather than a static one,
// guarantees that order.
process.env.INTERNAL_API_MASTER_KEY = "test-master-key";
const { derivePodToken } = await import("./internalToken");

describe("derivePodToken", () => {
    it("matches a plain HMAC-SHA256(master, replId) hex digest", () => {
        const expected = createHmac("sha256", "test-master-key").update("my-project").digest("hex");
        expect(derivePodToken("my-project")).toBe(expected);
    });

    it("is deterministic for the same replId", () => {
        expect(derivePodToken("my-project")).toBe(derivePodToken("my-project"));
    });

    it("differs between projects", () => {
        expect(derivePodToken("project-a")).not.toBe(derivePodToken("project-b"));
    });

    it("is a 64-character hex string (SHA-256 digest)", () => {
        expect(derivePodToken("x")).toMatch(/^[0-9a-f]{64}$/);
    });
});
