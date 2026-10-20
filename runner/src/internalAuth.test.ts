import { describe, it, expect } from "vitest";
import { isValidInternalToken } from "./internalAuth";

describe("isValidInternalToken", () => {
    it("accepts the exact expected token", () => {
        expect(isValidInternalToken("secret-token", "secret-token")).toBe(true);
    });

    it("rejects a wrong token of the same length", () => {
        expect(isValidInternalToken("secret-tokeX", "secret-token")).toBe(false);
    });

    it("rejects a token of a different length", () => {
        expect(isValidInternalToken("short", "secret-token")).toBe(false);
    });

    it("rejects a missing header", () => {
        expect(isValidInternalToken(undefined, "secret-token")).toBe(false);
    });

    it("rejects a non-string header value", () => {
        expect(isValidInternalToken(["secret-token"], "secret-token")).toBe(false);
    });

    it("rejects an empty string", () => {
        expect(isValidInternalToken("", "secret-token")).toBe(false);
    });
});
