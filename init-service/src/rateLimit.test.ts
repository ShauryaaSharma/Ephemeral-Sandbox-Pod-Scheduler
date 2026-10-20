import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import { rateLimit } from "./rateLimit";

function fakeReqRes(userId: string) {
    const req = { userId } as unknown as Request;
    const res = {
        status: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
    } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    return { req, res, next };
}

describe("rateLimit", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("allows a burst of RATE_LIMIT_MAX requests then blocks the next with 429 + Retry-After", () => {
        const max = Number(process.env.RATE_LIMIT_MAX) || 5;
        const { req, res, next } = fakeReqRes("user-a");

        for (let i = 0; i < max; i++) {
            rateLimit(req, res, next);
        }
        expect(next).toHaveBeenCalledTimes(max);

        rateLimit(req, res, next);
        expect(next).toHaveBeenCalledTimes(max); // not called again
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.set).toHaveBeenCalledWith("Retry-After", expect.any(String));
    });

    it("isolates buckets per user - exhausting one user's doesn't affect another's", () => {
        const max = Number(process.env.RATE_LIMIT_MAX) || 5;
        const a = fakeReqRes("user-b");
        for (let i = 0; i < max; i++) rateLimit(a.req, a.res, a.next);
        rateLimit(a.req, a.res, a.next); // exhausted
        expect(a.res.status).toHaveBeenCalledWith(429);

        const b = fakeReqRes("user-c");
        rateLimit(b.req, b.res, b.next);
        expect(b.next).toHaveBeenCalledTimes(1);
        expect(b.res.status).not.toHaveBeenCalled();
    });

    it("refills over the configured window, allowing requests again after waiting it out", () => {
        const max = Number(process.env.RATE_LIMIT_MAX) || 5;
        const windowMs = (Number(process.env.RATE_LIMIT_WINDOW_SECONDS) || 60) * 1000;
        const { req, res, next } = fakeReqRes("user-d");

        for (let i = 0; i < max; i++) rateLimit(req, res, next);
        rateLimit(req, res, next);
        expect(res.status).toHaveBeenCalledWith(429);

        vi.setSystemTime(Date.now() + windowMs);
        rateLimit(req, res, next);
        expect(next).toHaveBeenCalledTimes(max + 1); // the burst, plus this one
    });

    it("fails open (calls next) when req.userId is missing", () => {
        const { res, next } = fakeReqRes("unused");
        const reqWithoutUserId = {} as unknown as Request;
        rateLimit(reqWithoutUserId, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });
});
