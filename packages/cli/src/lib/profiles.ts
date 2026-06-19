/**
 * Profile CRUD and active profile resolution.
 * Profiles are stored as individual JSON files in ~/.config/oneplatform/profiles/.
 * The active profile pointer lives in ~/.config/oneplatform/config.json.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const CONFIG_DIR = join(homedir(), ".config", "oneplatform");
const PROFILES_DIR = join(CONFIG_DIR, "profiles");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const DEFAULT_PROFILE = "default";

export interface Profile {
  name: string;
  platformUrl: string;
  tenantId?: string;
  defaultOutput?: "json" | "table" | "tsv" | "jsonl";
  timeout?: number;
  insecureTls?: boolean;
}

interface GlobalConfig {
  activeProfile: string;
}

function ensureDirs(): void {
  mkdirSync(PROFILES_DIR, { recursive: true });
}

function readGlobalConfig(): GlobalConfig {
  if (!existsSync(CONFIG_FILE)) {
    return { activeProfile: DEFAULT_PROFILE };
  }
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as GlobalConfig;
}

function writeGlobalConfig(cfg: GlobalConfig): void {
  ensureDirs();
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

// Profile names are used as filesystem path components — restrict to safe chars.
const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid profile name "${name}". Use only alphanumeric, hyphens, underscores (max 64 chars).`,
    );
  }
}

function profilePath(name: string): string {
  validateProfileName(name);
  return join(PROFILES_DIR, `${name}.json`);
}

/** Returns the name of the currently active profile. */
export function getActiveProfileName(): string {
  const envProfile = process.env["OP_PROFILE"];
  if (envProfile) return envProfile;
  return readGlobalConfig().activeProfile;
}

/** Sets the active profile in the global config. */
export function setActiveProfile(name: string): void {
  writeGlobalConfig({ activeProfile: name });
}

/** Reads a profile by name. Returns null if not found. */
export function loadProfile(name: string): Profile | null {
  const path = profilePath(name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Profile;
}

/** Writes a profile to disk. Creates or updates. */
export function saveProfile(profile: Profile): void {
  ensureDirs();
  writeFileSync(profilePath(profile.name), JSON.stringify(profile, null, 2), "utf8");
}

/** Lists all profiles on disk. */
export function listProfiles(): Profile[] {
  ensureDirs();
  const files = readdirSync(PROFILES_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const name = f.replace(/\.json$/, "");
    const profile = loadProfile(name);
    // A file exists but is somehow malformed — skip gracefully
    if (!profile) return null;
    return profile;
  }).filter((p): p is Profile => p !== null);
}

/** Deletes a profile file from disk. */
export function deleteProfile(name: string): void {
  const path = profilePath(name);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/** Returns true if the named profile exists on disk. */
export function profileExists(name: string): boolean {
  return existsSync(profilePath(name));
}
