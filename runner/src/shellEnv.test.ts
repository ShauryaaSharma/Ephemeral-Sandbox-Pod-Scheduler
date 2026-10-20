import { describe, it, expect } from "vitest";
import { buildShellEnv } from "./shellEnv";

describe("buildShellEnv", () => {
    it("passes through PATH/LANG and fixes HOME/TERM/PORT", () => {
        const env = buildShellEnv({ PATH: "/usr/bin", LANG: "en_US.UTF-8" } as NodeJS.ProcessEnv);
        expect(env).toEqual({ PATH: "/usr/bin", LANG: "en_US.UTF-8", HOME: "/workspace", TERM: "xterm", PORT: "3000" });
    });

    it("omits PATH/LANG when unset in the source", () => {
        const env = buildShellEnv({} as NodeJS.ProcessEnv);
        expect(env).toEqual({ HOME: "/workspace", TERM: "xterm", PORT: "3000" });
    });

    it("never leaks secrets regardless of what's in the source env", () => {
        const env = buildShellEnv({
            AWS_ACCESS_KEY_ID: "x",
            AWS_SECRET_ACCESS_KEY: "y",
            JWT_PUBLIC_KEY: "z",
            OWNER_ID: "owner",
            INTERNAL_API_TOKEN: "token",
        } as NodeJS.ProcessEnv);
        expect(Object.keys(env).sort()).toEqual(["HOME", "PORT", "TERM"]);
    });
});
