import { createMiddleware } from "hono/factory";
import { randomBytes } from "crypto";

// UUID v7 (RFC 9562): 48-bit Unix timestamp (ms) in the high bits followed by
// random fill. Lexicographic sorting is chronological because the most
// significant bits carry the most significant time bits.
function uuidV7(): string {
  const now = Date.now();
  const rand = randomBytes(10);

  // Bytes 0-5: 48-bit timestamp (big-endian, most significant first)
  const timeHigh = Math.floor(now / 0x100000000) & 0xffff;
  const timeLow = now >>> 0;

  // Byte 6: version nibble (0111) + top 4 random bits
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const ver = 0x70 | (rand[0]! & 0x0f);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const randHigh = rand[1]!;

  // Byte 8: variant bits 10xx xxxx
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const variant = 0x80 | (rand[2]! & 0x3f);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const randLow = rand[3]!;

  const node = rand.subarray(4, 10);

  const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
  const nodeHex = Array.from(node).map((b) => hex(b ?? 0, 2)).join("");

  return [
    hex(timeHigh, 4) + hex(timeLow >>> 16, 4),
    hex(timeLow & 0xffff, 4),
    hex(ver, 2) + hex(randHigh, 2),
    hex(variant, 2) + hex(randLow, 2),
    nodeHex,
  ].join("-");
}

// requestIdMiddleware propagates an upstream X-Request-ID or generates a new
// UUID v7 if none is present. Sets c.var.requestId for the error handler to
// include in error responses (spec §6 Error Code Registry).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestIdMiddleware() {
  return createMiddleware(async (c, next) => {
    const incoming = c.req.header("X-Request-ID");
    const requestId = incoming && UUID_RE.test(incoming) ? incoming : uuidV7();

    c.set("requestId", requestId);
    c.header("X-Request-ID", requestId);

    await next();
  });
}
