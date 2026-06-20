/**
 * Credential read/write with a three-tier encryption strategy:
 *   Tier 1: OS keychain via keytar (primary, key never touches disk)
 *   Tier 2: HKDF-SHA256 from machine-id (fallback for headless/CI environments)
 *   Tier 3: OP_API_KEY + OP_PLATFORM_URL env vars (bypass for CI)
 *
 * The credentials.json file stores only AES-256-GCM ciphertext — the key is
 * either in the OS keychain (tier 1) or derived at runtime (tier 2).
 */
import { createCipheriv, createDecipheriv, randomBytes, createHmac } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { mkdirSync } from "node:fs";

const CONFIG_DIR = join(homedir(), ".config", "oneplatform");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");
// 600 in octal
const SECURE_MODE = 0o600;

export interface StoredCredential {
  platformUrl: string;
  apiKey: string; // "encrypted:AES256GCM:<base64>" or "plain:<value>" for tests
  keyDerivation: "keychain" | "machine-id";
  encryptedAt: string;
}

export type CredentialsStore = Record<string, StoredCredential>;

export interface ResolvedCredentials {
  apiKey: string | null;
  platformUrl: string | null;
  source: "keychain" | "machine-id" | "env" | "none";
}

// ─── Keytar (optional native binding) ──────────────────────────────────────

let _keytarChecked = false;
let _keytarAvailable = false;

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

/**
 * Loads keytar using an indirect import to avoid TypeScript static module resolution.
 * keytar is an optional native binding — its absence is the normal CI/headless path.
 */
async function loadKeytar(): Promise<KeytarModule | null> {
  try {
    // Using createRequire to bypass TypeScript's static import resolution.
    // TypeScript would otherwise error on a missing module declaration.
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const kt = req("keytar") as KeytarModule;
    return kt;
  } catch {
    return null;
  }
}

async function isKeytarAvailable(): Promise<boolean> {
  if (_keytarChecked) return _keytarAvailable;
  _keytarChecked = true;
  const kt = await loadKeytar();
  _keytarAvailable = kt !== null;
  return _keytarAvailable;
}

async function keytarGet(service: string, account: string): Promise<string | null> {
  const kt = await loadKeytar();
  if (!kt) return null;
  return kt.getPassword(service, account);
}

async function keytarSet(service: string, account: string, password: string): Promise<void> {
  const kt = await loadKeytar();
  if (!kt) throw new Error("keytar not available");
  await kt.setPassword(service, account, password);
}

// ─── Machine-ID derivation (HKDF-SHA256) ───────────────────────────────────

function readMachineId(): string {
  // User-configurable override for CI/headless environments
  const override = process.env["OP_MACHINE_ID"];
  if (override) return override;

  // Linux: /etc/machine-id or /var/lib/dbus/machine-id
  const candidates = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
  for (const path of candidates) {
    if (existsSync(path)) {
      return readFileSync(path, "utf8").trim();
    }
  }

  // macOS: IOPlatformUUID
  if (platform() === "darwin") {
    try {
      const output = execSync(
        "ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID",
      ).toString();
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } catch {
      // ioreg not available — fall through to weak fallback
    }
  }

  // Weak fallback using hostname + username
  console.warn(
    "Warning: Using weak machine identifier for credential encryption. " +
      "Set OP_MACHINE_ID env var for stronger protection.",
  );
  return createHmac("sha256", "oneplatform-fallback")
    .update(`${process.env["HOSTNAME"] ?? "localhost"}:${process.env["USER"] ?? "user"}`)
    .digest("hex");
}

function deriveMachineKey(): Buffer {
  const machineId = readMachineId();
  // HKDF-SHA256: extract then expand
  // Using createHmac as a simple HKDF-Extract step (IKM = machineId, salt = fixed)
  const prk = createHmac("sha256", "oneplatform-cli-v1").update(machineId).digest();
  // HKDF-Expand: T(1) = HMAC-Hash(PRK, "" || 0x01) — simplified single-block expansion
  const info = Buffer.from("credential-key");
  const t1 = createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();
  return t1; // 32 bytes
}

// ─── AES-256-GCM encrypt / decrypt ─────────────────────────────────────────

const ENCRYPTION_PREFIX = "encrypted:AES256GCM:";
const AUTH_TAG_LENGTH = 16;
const IV_LENGTH = 12;

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, ciphertext, authTag]);
  return ENCRYPTION_PREFIX + combined.toString("base64");
}

function decrypt(stored: string, key: Buffer): string {
  if (!stored.startsWith(ENCRYPTION_PREFIX)) {
    throw new Error("Credential is not in expected encrypted format.");
  }
  const combined = Buffer.from(stored.slice(ENCRYPTION_PREFIX.length), "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH, combined.length - AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// ─── Credential file I/O ────────────────────────────────────────────────────

function ensureConfigDir(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

function readCredentialsFile(): CredentialsStore {
  if (!existsSync(CREDENTIALS_FILE)) return {};
  return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) as CredentialsStore;
}

function writeCredentialsFile(store: CredentialsStore): void {
  ensureConfigDir();
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(store, null, 2), {
    encoding: "utf8",
    mode: SECURE_MODE,
  });
  // Ensure permissions are correct even on pre-existing files where mode
  // in writeFileSync options only applies to newly created files.
  chmodSync(CREDENTIALS_FILE, SECURE_MODE);
}

/**
 * Checks credentials.json permissions and warns if too permissive.
 * Called during context setup — warns but never blocks the command.
 */
export function checkCredentialsPermissions(): string | null {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  const stats = statSync(CREDENTIALS_FILE);
  // mode & 0o777 gives the permission bits
  const mode = stats.mode & 0o777;
  if ((mode & 0o177) !== 0) {
    return (
      `credentials.json has insecure permissions (${mode.toString(8)}).\n` +
      `Fix with: chmod 600 ${CREDENTIALS_FILE}`
    );
  }
  return null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolves credentials for a profile in priority order:
 *   1. OP_API_KEY + OP_PLATFORM_URL env vars
 *   2. Keychain (tier 1) or machine-id (tier 2) from credentials.json
 */
export async function loadCredentials(profileName: string): Promise<ResolvedCredentials> {
  const envKey = process.env["OP_API_KEY"];
  const envUrl = process.env["OP_PLATFORM_URL"];
  if (envKey && envUrl) {
    return { apiKey: envKey, platformUrl: envUrl, source: "env" };
  }

  const store = readCredentialsFile();
  const entry = store[profileName];
  if (!entry) {
    return { apiKey: null, platformUrl: null, source: "none" };
  }

  const { encryptedApiKey, derivation } = await decryptEntry(entry, profileName);
  return {
    apiKey: encryptedApiKey,
    platformUrl: entry.platformUrl,
    source: derivation,
  };
}

async function decryptEntry(
  entry: StoredCredential,
  profileName: string,
): Promise<{ encryptedApiKey: string; derivation: "keychain" | "machine-id" }> {
  if (entry.keyDerivation === "keychain" && (await isKeytarAvailable())) {
    // Account is scoped to profileName so two profiles sharing the same platformUrl
    // each get their own independent keychain entry and never collide.
    const account = `${profileName}:${entry.platformUrl}`;
    const encKey = await keytarGet("oneplatform-cli", account);
    if (encKey) {
      const key = Buffer.from(encKey, "base64");
      return { encryptedApiKey: decrypt(entry.apiKey, key), derivation: "keychain" };
    }
    // Keychain entry is missing — this credential cannot be decrypted with machine-id
    // because it was encrypted with a random 32-byte key that only the keychain holds.
    // Warn loudly: a missing keychain entry indicates credential theft or machine transfer,
    // not a recoverable fallback.
    process.stderr.write(
      `WARNING: Credential for profile '${profileName}' was stored using the system keychain, ` +
        `but the keychain entry is no longer present.\n` +
        `This may indicate the credentials file was copied from another machine or the keychain was cleared.\n` +
        `Run 'op auth login' to re-authenticate.\n`,
    );
    throw new Error(
      `Keychain entry missing for profile '${profileName}'. Cannot decrypt credentials. ` +
        `Run 'op auth login' to re-authenticate.`,
    );
  }
  // Machine-id derivation: used only when credential was originally stored with machine-id
  const key = deriveMachineKey();
  return { encryptedApiKey: decrypt(entry.apiKey, key), derivation: "machine-id" };
}

/**
 * Stores encrypted API key for a profile.
 * Attempts keychain first; falls back to machine-id and prints a warning.
 */
export async function saveCredentials(
  profileName: string,
  platformUrl: string,
  apiKey: string,
): Promise<"keychain" | "machine-id"> {
  let key: Buffer;
  let derivation: "keychain" | "machine-id";

  if (await isKeytarAvailable()) {
    key = randomBytes(32);
    // Account is scoped to profileName to avoid collisions when multiple profiles
    // point at the same platformUrl — each profile gets its own keychain entry.
    const account = `${profileName}:${platformUrl}`;
    await keytarSet("oneplatform-cli", account, key.toString("base64"));
    derivation = "keychain";
  } else {
    process.stderr.write(
      "WARNING: Credentials stored with machine-derived key (keytar not available).\n" +
        "Moving credentials.json to a different machine will make credentials unrecoverable.\n" +
        "For better security, install libsecret (Linux) to enable system keychain storage.\n",
    );
    key = deriveMachineKey();
    derivation = "machine-id";
  }

  const store = readCredentialsFile();
  store[profileName] = {
    platformUrl,
    apiKey: encrypt(apiKey, key),
    keyDerivation: derivation,
    encryptedAt: new Date().toISOString(),
  };
  writeCredentialsFile(store);
  return derivation;
}

/** Removes credentials for a profile from the store. */
export function deleteCredentials(profileName: string): void {
  const store = readCredentialsFile();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete store[profileName];
  writeCredentialsFile(store);
}
