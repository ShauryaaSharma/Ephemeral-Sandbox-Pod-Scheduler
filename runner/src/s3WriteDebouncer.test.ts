import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { S3WriteDebouncer } from "./s3WriteDebouncer";

describe("S3WriteDebouncer", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("writes once after the debounce window, with the latest content", async () => {
        const writeFn = vi.fn().mockResolvedValue(undefined);
        const debouncer = new S3WriteDebouncer(writeFn, 1500);

        debouncer.schedule("code/repl1", "/index.js", "v1");
        debouncer.schedule("code/repl1", "/index.js", "v2");
        debouncer.schedule("code/repl1", "/index.js", "v3");

        expect(writeFn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1500);

        expect(writeFn).toHaveBeenCalledTimes(1);
        expect(writeFn).toHaveBeenCalledWith("code/repl1", "/index.js", "v3");
    });

    it("restarts the window on every new write to the same file", async () => {
        const writeFn = vi.fn().mockResolvedValue(undefined);
        const debouncer = new S3WriteDebouncer(writeFn, 1500);

        debouncer.schedule("code/repl1", "/index.js", "v1");
        await vi.advanceTimersByTimeAsync(1000);
        debouncer.schedule("code/repl1", "/index.js", "v2");
        await vi.advanceTimersByTimeAsync(1000);

        // Still within the restarted window - no write yet.
        expect(writeFn).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(500);
        expect(writeFn).toHaveBeenCalledTimes(1);
        expect(writeFn).toHaveBeenCalledWith("code/repl1", "/index.js", "v2");
    });

    it("debounces different files independently", async () => {
        const writeFn = vi.fn().mockResolvedValue(undefined);
        const debouncer = new S3WriteDebouncer(writeFn, 1500);

        debouncer.schedule("code/repl1", "/a.js", "a");
        debouncer.schedule("code/repl1", "/b.js", "b");
        await vi.advanceTimersByTimeAsync(1500);

        expect(writeFn).toHaveBeenCalledTimes(2);
        expect(writeFn).toHaveBeenCalledWith("code/repl1", "/a.js", "a");
        expect(writeFn).toHaveBeenCalledWith("code/repl1", "/b.js", "b");
    });

    it("flush writes all pending files immediately and cancels their timers", async () => {
        const writeFn = vi.fn().mockResolvedValue(undefined);
        const debouncer = new S3WriteDebouncer(writeFn, 1500);

        debouncer.schedule("code/repl1", "/a.js", "a");
        debouncer.schedule("code/repl1", "/b.js", "b");
        expect(debouncer.pendingCount()).toBe(2);

        await debouncer.flush();

        expect(writeFn).toHaveBeenCalledTimes(2);
        expect(debouncer.pendingCount()).toBe(0);

        // The original timers must not fire a second write after flush.
        await vi.advanceTimersByTimeAsync(1500);
        expect(writeFn).toHaveBeenCalledTimes(2);
    });

    it("flush with nothing pending is a no-op", async () => {
        const writeFn = vi.fn().mockResolvedValue(undefined);
        const debouncer = new S3WriteDebouncer(writeFn, 1500);

        await expect(debouncer.flush()).resolves.toBeUndefined();
        expect(writeFn).not.toHaveBeenCalled();
    });

    it("logs instead of throwing when a debounced write fails", async () => {
        const writeFn = vi.fn().mockRejectedValue(new Error("boom"));
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const debouncer = new S3WriteDebouncer(writeFn, 1500);

        debouncer.schedule("code/repl1", "/index.js", "v1");
        await vi.advanceTimersByTimeAsync(1500);
        // Let the rejected promise's .catch handler run.
        await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());

        errorSpy.mockRestore();
    });
});
