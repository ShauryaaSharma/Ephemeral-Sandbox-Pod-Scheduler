import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CoreV1Api } from "@kubernetes/client-node";
import { withRetry, checkPodSchedulable, translateK8sError } from "./capacity";

describe("withRetry", () => {
    it("retries a transient 5xx then succeeds", async () => {
        let calls = 0;
        const fn = vi.fn(async () => {
            calls++;
            if (calls < 3) throw { statusCode: 503 };
            return "ok";
        });
        await expect(withRetry(fn, 3, 0)).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("never retries a 4xx", async () => {
        const fn = vi.fn(async () => {
            throw { statusCode: 400 };
        });
        await expect(withRetry(fn, 3, 0)).rejects.toMatchObject({ statusCode: 400 });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("exhausts its attempts and throws when a call always fails", async () => {
        const fn = vi.fn(async () => {
            throw { statusCode: 503 };
        });
        await expect(withRetry(fn, 3, 0)).rejects.toMatchObject({ statusCode: 503 });
        expect(fn).toHaveBeenCalledTimes(3);
    });
});

describe("translateK8sError", () => {
    it("translates a 409 conflict", () => {
        expect(translateK8sError({ statusCode: 409 }).status).toBe(409);
    });

    it("translates a quota-exceeded 403 to a 503 capacity message", () => {
        const result = translateK8sError({ statusCode: 403, body: { message: "exceeded quota: pods" } });
        expect(result.status).toBe(503);
        expect(result.message).toMatch(/capacity/i);
    });

    it("translates anything else to a generic 500", () => {
        expect(translateK8sError({ statusCode: 500 }).status).toBe(500);
        expect(translateK8sError(new Error("boom")).status).toBe(500);
    });
});

describe("checkPodSchedulable", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function fakeCoreV1Api(pod: unknown): CoreV1Api {
        return {
            listNamespacedPod: async () => ({ body: { items: pod ? [pod] : [] } }),
        } as unknown as CoreV1Api;
    }

    it("detects an explicitly Unschedulable pod", async () => {
        const api = fakeCoreV1Api({
            status: { conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "no nodes" }] },
        });
        const resultPromise = checkPodSchedulable(api, "repl-1");
        await vi.advanceTimersByTimeAsync(5000);
        const result = await resultPromise;
        expect(result).toEqual({ schedulable: false, reason: "no nodes" });
    });

    it("detects a Running pod as schedulable", async () => {
        const api = fakeCoreV1Api({ status: { phase: "Running", conditions: [{ type: "PodScheduled", status: "True" }] } });
        const resultPromise = checkPodSchedulable(api, "repl-2");
        await vi.advanceTimersByTimeAsync(5000);
        const result = await resultPromise;
        expect(result).toEqual({ schedulable: true });
    });

    it("falls back to schedulable for a pod stuck ambiguously Pending once the check window closes", async () => {
        const api = fakeCoreV1Api({ status: { phase: "Pending", conditions: [] } });
        const resultPromise = checkPodSchedulable(api, "repl-3");
        await vi.advanceTimersByTimeAsync(13000); // past the full ~12s check window
        const result = await resultPromise;
        expect(result).toEqual({ schedulable: true });
    });
});
