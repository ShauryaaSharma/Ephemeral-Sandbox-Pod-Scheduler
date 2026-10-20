import { describe, it, expect } from "vitest";
import { resolveInWorkspace } from "./fs";

describe("resolveInWorkspace", () => {
    it("resolves a simple relative path inside the workspace", () => {
        expect(resolveInWorkspace("index.js")).toBe("/workspace/index.js");
    });

    it("resolves a nested relative path", () => {
        expect(resolveInWorkspace("src/app.js")).toBe("/workspace/src/app.js");
    });

    it("resolves a leading-slash path the same way the wire protocol sends it", () => {
        // The existing protocol sends paths like "/index.js" (see fetchDir's
        // own baseDir/file.name construction) - these must keep working,
        // landing under /workspace rather than being rejected or escaping it.
        expect(resolveInWorkspace("/index.js")).toBe("/workspace/index.js");
        expect(resolveInWorkspace("/src/app.js")).toBe("/workspace/src/app.js");
    });

    it("resolves the workspace root itself", () => {
        expect(resolveInWorkspace(".")).toBe("/workspace");
        expect(resolveInWorkspace("")).toBe("/workspace");
    });

    it("allows a traversal that stays inside the workspace", () => {
        expect(resolveInWorkspace("src/../index.js")).toBe("/workspace/index.js");
    });

    it("throws on a traversal that escapes the workspace", () => {
        expect(() => resolveInWorkspace("../etc/passwd")).toThrow(/escapes workspace/);
        expect(() => resolveInWorkspace("../../etc/passwd")).toThrow(/escapes workspace/);
        expect(() => resolveInWorkspace("/../etc/passwd")).toThrow(/escapes workspace/);
        expect(() => resolveInWorkspace("a/../../b")).toThrow(/escapes workspace/);
    });
});
