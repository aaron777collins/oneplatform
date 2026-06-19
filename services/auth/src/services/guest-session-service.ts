// Guest session management for public apps.
// Guest sessions allow unauthenticated users to interact with public-facing
// apps without creating a platform account. The session is a 32-byte opaque
// hex token stored in Redis with a 24-hour TTL.
//
// Created by the App Service via the internal endpoint (L2 design §5).
// The token is set in the op_guest_session httpOnly cookie by the App Service.

import { randomBytes } from "crypto";
import type { Redis } from "ioredis";
import type { GuestSessionResult, GuestSessionPayload } from "./types.js";

// 24-hour TTL matches the guest-session Redis key pattern in L2 design §3
const GUEST_SESSION_TTL_SECONDS = 86_400;

// Per-IP rate limiting for guest session creation (defense-in-depth).
// Even though the endpoint is internal-only, a compromised upstream service
// could flood guest sessions. Window = 60 seconds, max 30 sessions per IP.
const GUEST_RATE_LIMIT_WINDOW_SECONDS = 60;
const GUEST_RATE_LIMIT_MAX_PER_WINDOW = 30;

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface GuestSessionServiceDeps {
  redis: Redis;
}

export interface GuestSessionService {
  create(
    tenantId: string,
    appId: string,
    ipAddress?: string
  ): Promise<GuestSessionResult>;
  validate(token: string): Promise<GuestSessionPayload | null>;
}

export function createGuestSessionService(
  deps: GuestSessionServiceDeps
): GuestSessionService {
  const { redis } = deps;

  // -------------------------------------------------------------------------
  // Create guest session
  // -------------------------------------------------------------------------

  async function create(
    tenantId: string,
    appId: string,
    ipAddress?: string
  ): Promise<GuestSessionResult> {
    if (!tenantId) {
      throw new Error("tenantId is required to create a guest session.");
    }
    if (!appId) {
      throw new Error("appId is required to create a guest session.");
    }

    // Per-IP rate limiting (defense-in-depth for internal endpoint)
    if (ipAddress) {
      const rateLimitKey = `guest-session:rate:${ipAddress}`;
      const currentCount = await redis.incr(rateLimitKey);
      if (currentCount === 1) {
        // First request in the window — set expiry
        await redis.expire(rateLimitKey, GUEST_RATE_LIMIT_WINDOW_SECONDS);
      }
      if (currentCount > GUEST_RATE_LIMIT_MAX_PER_WINDOW) {
        throw new Error(
          `Rate limit exceeded: too many guest sessions from IP ${ipAddress}. ` +
          `Max ${GUEST_RATE_LIMIT_MAX_PER_WINDOW} per ${GUEST_RATE_LIMIT_WINDOW_SECONDS}s window.`,
        );
      }
    }

    // 32 random bytes → 64 hex chars (L2 design §5)
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + GUEST_SESSION_TTL_SECONDS * 1_000);

    const payload: GuestSessionPayload = {
      tenantId,
      appId,
      createdAt: new Date().toISOString(),
      ...(ipAddress !== undefined && { ipAddress }),
    };

    await redis.set(
      `guest-session:${token}`,
      JSON.stringify(payload),
      "EX",
      GUEST_SESSION_TTL_SECONDS
    );

    return { guestToken: token, expiresAt };
  }

  // -------------------------------------------------------------------------
  // Validate guest session
  // -------------------------------------------------------------------------

  async function validate(token: string): Promise<GuestSessionPayload | null> {
    if (!token || token.length !== 64) {
      // Reject malformed tokens without touching Redis
      return null;
    }

    const raw = await redis.get(`guest-session:${token}`);
    if (raw === null) return null;

    try {
      return JSON.parse(raw) as GuestSessionPayload;
    } catch {
      // Corrupt Redis entry — treat as invalid
      return null;
    }
  }

  // -------------------------------------------------------------------------

  return { create, validate };
}
