import { createMiddleware } from "hono/factory";
import { randomBytes } from "crypto";

// UUID v7 encodes a sortable millisecond timestamp in the first 48 bits.
// This lets ops sort log lines by requestId chronologically without a separate
// timestamp — critical when tracing distributed requests (spec §12, W3C Trace Context).
function uuidV7(): string {
  const now = BigInt(Date.now());
  const bytes = randomBytes(10);

  // 48-bit timestamp (ms precision)
  const timeLow = Number(now & BigInt(0xffffffff));
  const timeMid = Number((now >> BigInt(32)) & BigInt(0xffff));

  // Version nibble = 7
  const timeHighAndVersion = (Number((now >> BigInt(48)) & BigInt(0x0fff)) | 0x7000);

  // variant bits: 10xx xxxx (RFC 4122 variant 1)
  // Non-null assertions are safe: randomBytes(10) always returns exactly 10 bytes.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const clockSeq = (bytes[0]! & 0x3f) | 0x80;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const clockSeqLow = bytes[1]!;

  const node = bytes.subarray(2, 8);

  const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
  const nodeHex = Array.from(node).map((b) => hex(b ?? 0, 2)).join("");

  return [
    hex(timeLow, 8),
    hex(timeMid, 4),
    hex(timeHighAndVersion, 4),
    hex(clockSeq, 2) + hex(clockSeqLow, 2),
    nodeHex,
  ].join("-");
}

// requestIdMiddleware propagates an upstream X-Request-ID or generates a new
// UUID v7 if none is present. Sets c.var.requestId for the error handler to
// include in error responses (spec §6 Error Code Registry).
export function requestIdMiddleware() {
  return createMiddleware(async (c, next) => {
    const incoming = c.req.header("X-Request-ID");
    const requestId = incoming ?? uuidV7();

    c.set("requestId", requestId);
    c.header("X-Request-ID", requestId);

    await next();
  });
}
