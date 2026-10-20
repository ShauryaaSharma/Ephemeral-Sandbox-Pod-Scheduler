import { describe, it, expect } from "vitest";
import { isValidReplId, isValidLanguage } from "./validators";

describe("isValidReplId", () => {
    it("accepts a simple lowercase-alphanumeric id", () => {
        expect(isValidReplId("my-project1")).toBe(true);
    });

    it("accepts a single character", () => {
        expect(isValidReplId("a")).toBe(true);
    });

    it("accepts the maximum length (40 chars)", () => {
        expect(isValidReplId("a" + "b".repeat(38) + "c")).toBe(true);
    });

    it("rejects an id one character over the maximum length", () => {
        expect(isValidReplId("a" + "b".repeat(39) + "c")).toBe(false);
    });

    it("rejects uppercase letters", () => {
        expect(isValidReplId("MyProject")).toBe(false);
    });

    it("rejects a leading hyphen", () => {
        expect(isValidReplId("-project")).toBe(false);
    });

    it("rejects a trailing hyphen", () => {
        expect(isValidReplId("project-")).toBe(false);
    });

    it("rejects path traversal attempts", () => {
        expect(isValidReplId("../../etc/passwd")).toBe(false);
    });

    it("rejects an empty string", () => {
        expect(isValidReplId("")).toBe(false);
    });

    it("rejects non-string input", () => {
        expect(isValidReplId(123)).toBe(false);
        expect(isValidReplId(undefined)).toBe(false);
        expect(isValidReplId(null)).toBe(false);
    });
});

describe("isValidLanguage", () => {
    it("accepts node-js", () => {
        expect(isValidLanguage("node-js")).toBe(true);
    });

    it("accepts python", () => {
        expect(isValidLanguage("python")).toBe(true);
    });

    it("rejects an unknown language", () => {
        expect(isValidLanguage("ruby")).toBe(false);
    });

    it("rejects path traversal attempts", () => {
        expect(isValidLanguage("../secrets")).toBe(false);
    });

    it("rejects non-string input", () => {
        expect(isValidLanguage(undefined)).toBe(false);
        expect(isValidLanguage(42)).toBe(false);
    });
});
