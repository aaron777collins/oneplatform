// Password hashing and comparison using bcrypt.
//
// The dummy hash is generated once at module load time and used on the
// "user not found" code path in auth-service so every login attempt
// runs through a full bcrypt.compare regardless of whether the email exists.
// This prevents timing-based user enumeration (L2 design §9.1).

import bcrypt from "bcrypt";

// Minimum cost to prevent brute-force attacks even on fast hardware.
// The L2 design prohibits setting this below 10.
const MIN_BCRYPT_ROUNDS = 10;
const DEFAULT_BCRYPT_ROUNDS = 12;

function resolveRounds(): number {
  const raw = process.env["OP_BCRYPT_ROUNDS"];
  if (raw === undefined) return DEFAULT_BCRYPT_ROUNDS;

  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(
      `OP_BCRYPT_ROUNDS must be an integer, got: "${raw}"`
    );
  }
  if (parsed < MIN_BCRYPT_ROUNDS) {
    throw new Error(
      `OP_BCRYPT_ROUNDS must be at least ${MIN_BCRYPT_ROUNDS}, got: ${parsed}. ` +
        "Lower values are insecure and rejected at startup."
    );
  }
  return parsed;
}

// Generate the dummy hash eagerly at module load so the first failed login
// for a non-existent user doesn't pay an extra hash cost to initialise it.
// The value is random so it can never be reversed to a real password.
const DUMMY_HASH: Promise<string> = bcrypt.hash(
  // One-time random value, never matches any real input
  `__dummy__${Math.random().toString(36)}__${Date.now()}`,
  DEFAULT_BCRYPT_ROUNDS
);

export interface PasswordService {
  hash(password: string): Promise<string>;
  compare(password: string, hash: string): Promise<boolean>;
  /** Always returns false — runs full bcrypt compare for timing safety. */
  compareDummy(password: string): Promise<boolean>;
}

export function createPasswordService(): PasswordService {
  const rounds = resolveRounds();

  return {
    async hash(password: string): Promise<string> {
      if (!password) {
        throw new Error("Password must not be empty before hashing.");
      }
      return bcrypt.hash(password, rounds);
    },

    async compare(password: string, storedHash: string): Promise<boolean> {
      if (!password || !storedHash) return false;
      return bcrypt.compare(password, storedHash);
    },

    async compareDummy(password: string): Promise<boolean> {
      // Always run a full bcrypt.compare against the pre-computed dummy hash
      // so the caller's timing is indistinguishable from a real failed login.
      // The result is discarded — this method always returns false.
      await bcrypt.compare(password, await DUMMY_HASH);
      return false;
    },
  };
}
