import { createHmac, timingSafeEqual } from "crypto";
import { InvalidCursorError, CursorExpiredError } from "./errors.js";

// Cursor TTL matches the spec §6 Pagination section: 24 hours.
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

interface CursorEnvelope {
  payload: Record<string, unknown>;
  // Unix epoch milliseconds — used to enforce 24h expiry
  issuedAt: number;
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

// Wire format: base64url(JSON envelope) . HMAC-SHA256 signature
// The dot separator allows splitting without ambiguity since base64url has no dots.
export async function encodeCursor(
  payload: Record<string, unknown>,
  secret: string
): Promise<string> {
  const envelope: CursorEnvelope = { payload, issuedAt: Date.now() };
  const body = Buffer.from(JSON.stringify(envelope)).toString("base64url");
  const sig = sign(body, secret);
  return `${body}.${sig}`;
}

export async function decodeCursor(
  cursor: string,
  secret: string
): Promise<Record<string, unknown>> {
  let body: string;
  let sig: string;

  try {
    const dotIndex = cursor.lastIndexOf(".");
    if (dotIndex === -1) throw new Error("No separator");
    body = cursor.slice(0, dotIndex);
    sig = cursor.slice(dotIndex + 1);
  } catch {
    throw new InvalidCursorError("Cursor format is invalid");
  }

  // Constant-time comparison prevents timing attacks on the HMAC
  const expectedSig = sign(body, secret);
  const sigBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expectedSig);

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    throw new InvalidCursorError("Cursor signature is invalid");
  }

  let envelope: CursorEnvelope;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    envelope = JSON.parse(json) as CursorEnvelope;
  } catch {
    throw new InvalidCursorError("Cursor payload could not be decoded");
  }

  const ageMs = Date.now() - envelope.issuedAt;
  if (ageMs > CURSOR_TTL_MS) {
    throw new CursorExpiredError("Cursor has expired (older than 24 hours)");
  }

  return envelope.payload;
}
