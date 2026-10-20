import { describe, it, expect } from "vitest";
import { parseAllowedOrigins } from "./corsOrigins";

describe("parseAllowedOrigins", () => {
    it("splits a comma-separated list and trims whitespace", () => {
        expect(parseAllowedOrigins("https://a.example.com, https://b.example.com", "development")).toEqual([
            "https://a.example.com",
            "https://b.example.com",
        ]);
    });

    it("returns a single-element array for one origin", () => {
        expect(parseAllowedOrigins("https://a.example.com", "production")).toEqual(["https://a.example.com"]);
    });

    it("drops empty entries from trailing/double commas", () => {
        expect(parseAllowedOrigins("https://a.example.com,,", "development")).toEqual(["https://a.example.com"]);
    });

    it("defaults to localhost:5173 in development when unset", () => {
        expect(parseAllowedOrigins(undefined, "development")).toEqual(["http://localhost:5173"]);
    });

    it("defaults to localhost:5173 when NODE_ENV is unset", () => {
        expect(parseAllowedOrigins(undefined, undefined)).toEqual(["http://localhost:5173"]);
    });

    it("treats a blank string the same as unset", () => {
        expect(parseAllowedOrigins("   ", "development")).toEqual(["http://localhost:5173"]);
    });

    it("throws in production when unset", () => {
        expect(() => parseAllowedOrigins(undefined, "production")).toThrow(/ALLOWED_ORIGINS/);
    });

    it("throws in production when blank", () => {
        expect(() => parseAllowedOrigins("   ", "production")).toThrow(/ALLOWED_ORIGINS/);
    });
});
