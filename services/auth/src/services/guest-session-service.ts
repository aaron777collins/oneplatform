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
