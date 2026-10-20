import { timingSafeEqual } from "crypto";

// Constant-time comparison so a timing side channel can't be used to guess
// INTERNAL_API_TOKEN byte-by-byte. timingSafeEqual throws (rather than
// returning false) on a buffer-length mismatch, so that's checked first -
// this does leak whether the length matches, but not which bytes are wrong,
// which is the comparison that actually matters for a fixed-length secret.
export function isValidInternalToken(provided: unknown, expected: string): boolean {
    if (typeof provided !== "string" || provided.length === 0) return false;
    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);
    if (providedBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(providedBuf, expectedBuf);
}
