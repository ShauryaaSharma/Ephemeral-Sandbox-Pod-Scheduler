import { Request, Response, NextFunction } from "express";

// Per-user (not per-IP) token bucket - keyed by the authenticated userId
// from requireAuth, so this must run after that middleware. IP-based limits
// are trivially bypassed by anyone with multiple devices/browsers, and
// don't distinguish two different users behind the same NAT/proxy; the
// userId from a verified JWT is the identity that actually matters here.
const MAX_TOKENS = Number(process.env.RATE_LIMIT_MAX) || 5;
const REFILL_WINDOW_MS = (Number(process.env.RATE_LIMIT_WINDOW_SECONDS) || 60) * 1000;
const BUCKET_IDLE_EVICTION_MS = 60 * 60 * 1000; // sweep buckets untouched for an hour

interface Bucket {
    tokens: number;
    lastRefillAt: number;
}

const buckets = new Map<string, Bucket>();

// Bounds memory for a long-running process - otherwise every anonymous
// userId that ever calls this endpoint keeps a bucket forever.
setInterval(() => {
    const cutoff = Date.now() - BUCKET_IDLE_EVICTION_MS;
    for (const [userId, bucket] of buckets) {
        if (bucket.lastRefillAt < cutoff) buckets.delete(userId);
    }
}, BUCKET_IDLE_EVICTION_MS).unref();

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const userId = req.userId;
    if (!userId) {
        // requireAuth should always run first and populate this - fail open
        // rather than block a request over a wiring mistake elsewhere.
        next();
        return;
    }

    const now = Date.now();
    let bucket = buckets.get(userId);
    if (!bucket) {
        bucket = { tokens: MAX_TOKENS, lastRefillAt: now };
        buckets.set(userId, bucket);
    }

    const elapsedMs = now - bucket.lastRefillAt;
    const refill = (elapsedMs / REFILL_WINDOW_MS) * MAX_TOKENS;
    bucket.tokens = Math.min(MAX_TOKENS, bucket.tokens + refill);
    bucket.lastRefillAt = now;

    if (bucket.tokens < 1) {
        const retryAfterSeconds = Math.ceil(REFILL_WINDOW_MS / MAX_TOKENS / 1000);
        res.status(429).set("Retry-After", String(retryAfterSeconds)).send({
            message: `Rate limit exceeded - please slow down and try again in ~${retryAfterSeconds}s.`,
        });
        return;
    }

    bucket.tokens -= 1;
    next();
}
