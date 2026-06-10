import type { Redis } from "ioredis";
import type {
  RefreshTokenPayload,
  OAuthStatePayload,
  GuestSessionPayload,
} from "./types.js";

// ---------------------------------------------------------------------------
// Key builders — single source of truth for Redis key patterns.
// See L2 design §3 Redis Key Inventory.
// ---------------------------------------------------------------------------
const keys = {
  refreshToken: (token: string) => `auth:refresh:${token}`,
  revocation: (jti: string) => `revocation:${jti}`,
  resetToken: (jti: string) => `reset:${jti}`,
  verifyToken: (jti: string) => `auth:verify:${jti}`,
  oauthState: (state: string) => `auth:oauth:state:${state}`,
  guestSession: (token: string) => `guest-session:${token}`,
  bootstrapAttempts: (ip: string) => `auth:bootstrap:attempts:${ip}`,
  apiKeyRevocation: (keyId: string) => `auth:apikey:revocation:${keyId}`,
} as const;

export class RedisStore {
  constructor(private readonly redis: Redis) {}

  // ---------------------------------------------------------------------------
  // Refresh tokens
  // ---------------------------------------------------------------------------

  async storeRefreshToken(
    token: string,
    payload: RefreshTokenPayload,
    ttl: number
  ): Promise<void> {
    await this.redis.set(
      keys.refreshToken(token),
      JSON.stringify(payload),
      "EX",
      ttl
    );
  }

  async getRefreshToken(token: string): Promise<RefreshTokenPayload | null> {
    const raw = await this.redis.get(keys.refreshToken(token));
    if (raw === null) return null;
    return JSON.parse(raw) as RefreshTokenPayload;
  }

  async deleteRefreshToken(token: string): Promise<number> {
    return this.redis.del(keys.refreshToken(token));
  }

  // ---------------------------------------------------------------------------
  // Access token revocation blocklist
  // ---------------------------------------------------------------------------

  // Adds the JTI to the revocation blocklist with a TTL equal to the token's
  // remaining lifetime so the entry auto-expires when the token would have
  // expired anyway, preventing unbounded growth.
  async revokeAccessToken(jti: string, ttl: number): Promise<void> {
    await this.redis.set(keys.revocation(jti), "1", "EX", ttl);
  }

  // ---------------------------------------------------------------------------
  // Password reset single-use tokens
  // ---------------------------------------------------------------------------

  async storeResetToken(jti: string, ttl: number): Promise<void> {
    await this.redis.set(keys.resetToken(jti), "1", "EX", ttl);
  }

  // Atomic DEL — returns true only if the key existed and was deleted.
  // This prevents a race where two concurrent requests both observe the key
  // before either deletes it.
  async consumeResetToken(jti: string): Promise<boolean> {
    const deleted = await this.redis.del(keys.resetToken(jti));
    return deleted === 1;
  }

  // ---------------------------------------------------------------------------
  // Email verification single-use tokens
  // ---------------------------------------------------------------------------

  async storeVerifyToken(jti: string, ttl: number): Promise<void> {
    await this.redis.set(keys.verifyToken(jti), "1", "EX", ttl);
  }

  async consumeVerifyToken(jti: string): Promise<boolean> {
    const deleted = await this.redis.del(keys.verifyToken(jti));
    return deleted === 1;
  }

  // ---------------------------------------------------------------------------
  // OAuth state parameter (CSRF + PKCE)
  // ---------------------------------------------------------------------------

  async storeOAuthState(
    state: string,
    payload: OAuthStatePayload,
    ttl: number
  ): Promise<void> {
    await this.redis.set(
      keys.oauthState(state),
      JSON.stringify(payload),
      "EX",
      ttl
    );
  }

  // Atomically reads and deletes the OAuth state so it can only be used once.
  // ioredis does not expose a native GETDEL command on all server versions,
  // so we use a Lua script which is guaranteed atomic by Redis's single-
  // threaded execution model.
  async getAndDeleteOAuthState(state: string): Promise<OAuthStatePayload | null> {
    const script = `
      local v = redis.call('GET', KEYS[1])
      if v then redis.call('DEL', KEYS[1]) end
      return v
    `;
    const raw = await this.redis.eval(script, 1, keys.oauthState(state)) as string | null;
    if (raw === null) return null;
    return JSON.parse(raw) as OAuthStatePayload;
  }

  // ---------------------------------------------------------------------------
  // Guest sessions
  // ---------------------------------------------------------------------------

  async storeGuestSession(
    token: string,
    payload: GuestSessionPayload,
    ttl: number
  ): Promise<void> {
    await this.redis.set(
      keys.guestSession(token),
      JSON.stringify(payload),
      "EX",
      ttl
    );
  }

  // ---------------------------------------------------------------------------
  // Bootstrap rate limiting
  // ---------------------------------------------------------------------------

  // Returns the current number of bootstrap attempts from the given IP.
  async getBootstrapAttempts(ip: string): Promise<number> {
    const raw = await this.redis.get(keys.bootstrapAttempts(ip));
    if (raw === null) return 0;
    const parsed = parseInt(raw, 10);
    return isNaN(parsed) ? 0 : parsed;
  }

  // Increments the counter and sets a TTL on first use (NX + EXPIRE is two
  // round trips; using INCR + conditional EXPIRE avoids a race window where
  // the key might be deleted between GET and SET).
  async incrementBootstrapAttempts(ip: string, ttl: number): Promise<number> {
    const key = keys.bootstrapAttempts(ip);
    const newCount = await this.redis.incr(key);
    // Only set the expiry on the first increment so subsequent increments do
    // not reset the window — the counter expires with the original TTL.
    if (newCount === 1) {
      await this.redis.expire(key, ttl);
    }
    return newCount;
  }

  // ---------------------------------------------------------------------------
  // API key revocation (no TTL — persists until key is deleted from DB)
  // ---------------------------------------------------------------------------

  async revokeApiKey(keyId: string): Promise<void> {
    await this.redis.set(keys.apiKeyRevocation(keyId), "1");
  }

  async isApiKeyRevoked(keyId: string): Promise<boolean> {
    const result = await this.redis.exists(keys.apiKeyRevocation(keyId));
    return result === 1;
  }
}
