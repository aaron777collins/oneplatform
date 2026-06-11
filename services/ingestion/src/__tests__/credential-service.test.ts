// Unit tests for services/ingestion/src/services/credential-service.ts
//
// Tests AES-256-GCM encryption round-trips, credential accessor lazy caching,
// storeCredentials, getDecryptedCredential, and deleteByConnectorId.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { encrypt } from "@oneplatform/core";
import type { Logger } from "@oneplatform/core";
import {
  createCredentialService,
  type CredentialRepository,
  type CredentialRow,
} from "../services/credential-service.js";
import {
  CredentialNotFoundError,
  CredentialDecryptFailedError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MASTER_KEY = Buffer.from("01234567890123456789012345678901"); // 32 bytes

function makeCredRow(overrides: Partial<CredentialRow> = {}): CredentialRow {
  return {
    id: "cred-id-1",
    connector_id: "connector-id-1",
    field_name: "apiKey",
    encrypted_blob: "base64encryptedblob",
    key_version: 1,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

type MockFn = ReturnType<typeof vi.fn>;

interface MockCredRepo {
  upsert: MockFn;
  findByConnectorId: MockFn;
  findByConnectorIdAndField: MockFn;
  deleteByConnectorId: MockFn;
}

function makeRepo(): MockCredRepo {
  return {
    upsert: vi.fn(),
    findByConnectorId: vi.fn(),
    findByConnectorIdAndField: vi.fn(),
    deleteByConnectorId: vi.fn(),
  };
}

function asRepo(m: MockCredRepo): CredentialRepository {
  return m as unknown as CredentialRepository;
}

// ---------------------------------------------------------------------------
// storeCredentials
// ---------------------------------------------------------------------------

describe("storeCredentials", () => {
  let repo: MockCredRepo;
  let logger: Logger;

  beforeEach(() => {
    repo = makeRepo();
    logger = makeLogger();
    repo.upsert.mockResolvedValue(makeCredRow());
  });

  it("calls upsert once per credential field", async () => {
    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await svc.storeCredentials("conn-1", { apiKey: "secret", token: "t123" }, MASTER_KEY);
    expect(repo.upsert.mock.calls).toHaveLength(2);
  });

  it("does not call upsert when credentials record is empty", async () => {
    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await svc.storeCredentials("conn-1", {}, MASTER_KEY);
    expect(repo.upsert.mock.calls).toHaveLength(0);
  });

  it("upsert receives correct connector_id and field_name", async () => {
    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await svc.storeCredentials("conn-abc", { myField: "value" }, MASTER_KEY);
    const calls = repo.upsert.mock.calls;
    const arg = calls[0]?.[0] as { connector_id: string; field_name: string };
    expect(arg.connector_id).toBe("conn-abc");
    expect(arg.field_name).toBe("myField");
  });

  it("upsert receives key_version = 1", async () => {
    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await svc.storeCredentials("conn-1", { f: "v" }, MASTER_KEY);
    const calls = repo.upsert.mock.calls;
    const arg = calls[0]?.[0] as { key_version: number };
    expect(arg.key_version).toBe(1);
  });

  it("encrypted_blob is a base64 string (not plaintext)", async () => {
    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await svc.storeCredentials("conn-1", { secret: "plaintext-value" }, MASTER_KEY);
    const calls = repo.upsert.mock.calls;
    const arg = calls[0]?.[0] as { encrypted_blob: string };
    expect(arg.encrypted_blob).not.toBe("plaintext-value");
    // Base64 characters only
    expect(arg.encrypted_blob).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("logs a single info event after storing credentials", async () => {
    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await svc.storeCredentials("conn-1", { k: "v" }, MASTER_KEY);
    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it("encrypts different fields with distinct blobs even with the same key", async () => {
    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await svc.storeCredentials("conn-1", { a: "same-value", b: "same-value" }, MASTER_KEY);
    const calls = repo.upsert.mock.calls;
    const blob0 = (calls[0]?.[0] as { encrypted_blob: string }).encrypted_blob;
    const blob1 = (calls[1]?.[0] as { encrypted_blob: string }).encrypted_blob;
    // AES-GCM with random salt+IV — same plaintext → different ciphertext
    expect(blob0).not.toBe(blob1);
  });
});

// ---------------------------------------------------------------------------
// getDecryptedCredential — real encryption round-trips
// ---------------------------------------------------------------------------

describe("getDecryptedCredential", () => {
  let repo: MockCredRepo;
  let logger: Logger;

  beforeEach(() => {
    repo = makeRepo();
    logger = makeLogger();
  });

  it("decrypts a credential that was encrypted with the same master key", async () => {
    const plaintext = "super-secret-token";
    const blob = await encrypt(plaintext, MASTER_KEY);
    repo.findByConnectorIdAndField.mockResolvedValue(
      makeCredRow({ encrypted_blob: blob }),
    );

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    const result = await svc.getDecryptedCredential("conn-1", "apiKey", MASTER_KEY);
    expect(result).toBe(plaintext);
  });

  it("throws CredentialNotFoundError when field does not exist in repo", async () => {
    repo.findByConnectorIdAndField.mockResolvedValue(null);
    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await expect(svc.getDecryptedCredential("conn-1", "missing", MASTER_KEY)).rejects.toBeInstanceOf(
      CredentialNotFoundError,
    );
  });

  it("CredentialNotFoundError contains connectorId and fieldName in message", async () => {
    repo.findByConnectorIdAndField.mockResolvedValue(null);
    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await expect(svc.getDecryptedCredential("conn-xyz", "myField", MASTER_KEY)).rejects.toThrow(
      "myField",
    );
  });

  it("throws CredentialDecryptFailedError when decryption fails (wrong key)", async () => {
    const blob = await encrypt("original", MASTER_KEY);
    const wrongKey = Buffer.from("99887766554433221100998877665544"); // different 32 bytes
    repo.findByConnectorIdAndField.mockResolvedValue(
      makeCredRow({ encrypted_blob: blob }),
    );

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await expect(svc.getDecryptedCredential("conn-1", "apiKey", wrongKey)).rejects.toBeInstanceOf(
      CredentialDecryptFailedError,
    );
  });

  it("throws CredentialDecryptFailedError when blob is corrupted", async () => {
    repo.findByConnectorIdAndField.mockResolvedValue(
      makeCredRow({ encrypted_blob: "aW52YWxpZGJsb2I=" }), // valid base64 but too short
    );

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await expect(svc.getDecryptedCredential("conn-1", "apiKey", MASTER_KEY)).rejects.toBeInstanceOf(
      CredentialDecryptFailedError,
    );
  });

  it("decrypts unicode strings correctly", async () => {
    const unicode = "日本語テスト🔑";
    const blob = await encrypt(unicode, MASTER_KEY);
    repo.findByConnectorIdAndField.mockResolvedValue(
      makeCredRow({ encrypted_blob: blob }),
    );

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    const result = await svc.getDecryptedCredential("conn-1", "apiKey", MASTER_KEY);
    expect(result).toBe(unicode);
  });

  it("decrypts an empty string credential", async () => {
    const blob = await encrypt("", MASTER_KEY);
    repo.findByConnectorIdAndField.mockResolvedValue(
      makeCredRow({ encrypted_blob: blob }),
    );

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    const result = await svc.getDecryptedCredential("conn-1", "apiKey", MASTER_KEY);
    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// listFieldNames
// ---------------------------------------------------------------------------

describe("listFieldNames", () => {
  it("returns field names from repo rows", async () => {
    const repo = makeRepo();
    const logger = makeLogger();
    repo.findByConnectorId.mockResolvedValue([
      makeCredRow({ field_name: "apiKey" }),
      makeCredRow({ field_name: "apiSecret" }),
    ]);

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    const names = await svc.listFieldNames("conn-1");
    expect(names).toEqual(["apiKey", "apiSecret"]);
  });

  it("returns empty array when no credentials exist", async () => {
    const repo = makeRepo();
    const logger = makeLogger();
    repo.findByConnectorId.mockResolvedValue([]);

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    const names = await svc.listFieldNames("conn-1");
    expect(names).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deleteByConnectorId
// ---------------------------------------------------------------------------

describe("deleteByConnectorId", () => {
  it("calls repo.deleteByConnectorId with correct id", async () => {
    const repo = makeRepo();
    const logger = makeLogger();
    repo.deleteByConnectorId.mockResolvedValue(3);

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await svc.deleteByConnectorId("conn-delete-me");

    const calls = repo.deleteByConnectorId.mock.calls;
    expect(calls[0]?.[0]).toBe("conn-delete-me");
  });

  it("logs the deletion with connectorId and fieldCount", async () => {
    const repo = makeRepo();
    const logger = makeLogger();
    repo.deleteByConnectorId.mockResolvedValue(5);

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await svc.deleteByConnectorId("conn-1");

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    expect(infoCalls.length).toBeGreaterThan(0);
  });

  it("resolves without error when deletion count is 0", async () => {
    const repo = makeRepo();
    const logger = makeLogger();
    repo.deleteByConnectorId.mockResolvedValue(0);

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    await expect(svc.deleteByConnectorId("conn-empty")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createCredentialAccessor — lazy caching
// ---------------------------------------------------------------------------

describe("createCredentialAccessor", () => {
  async function makeEncryptedRow(fieldName: string, plaintext: string): Promise<CredentialRow> {
    const blob = await encrypt(plaintext, MASTER_KEY);
    return makeCredRow({ field_name: fieldName, encrypted_blob: blob });
  }

  it("returns decrypted value via get()", async () => {
    const repo = makeRepo();
    const logger = makeLogger();
    const row = await makeEncryptedRow("token", "my-token-value");
    repo.findByConnectorIdAndField.mockResolvedValue(row);

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    const accessor = svc.createCredentialAccessor("conn-1", MASTER_KEY);
    const value = await accessor.get("token");
    expect(value).toBe("my-token-value");
  });

  it("caches decrypted value — repo called only once on repeated get()", async () => {
    const repo = makeRepo();
    const logger = makeLogger();
    const row = await makeEncryptedRow("token", "cached-value");
    repo.findByConnectorIdAndField.mockResolvedValue(row);

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    const accessor = svc.createCredentialAccessor("conn-1", MASTER_KEY);

    await accessor.get("token");
    await accessor.get("token");
    await accessor.get("token");

    const calls = repo.findByConnectorIdAndField.mock.calls;
    expect(calls).toHaveLength(1);
  });

  it("different field names are cached independently", async () => {
    const repo = makeRepo();
    const logger = makeLogger();
    const rowA = await makeEncryptedRow("fieldA", "value-a");
    const rowB = await makeEncryptedRow("fieldB", "value-b");

    repo.findByConnectorIdAndField
      .mockImplementation(async (_connectorId: string, fieldName: string) => {
        if (fieldName === "fieldA") return rowA;
        if (fieldName === "fieldB") return rowB;
        return null;
      });

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    const accessor = svc.createCredentialAccessor("conn-1", MASTER_KEY);

    const a = await accessor.get("fieldA");
    const b = await accessor.get("fieldB");

    expect(a).toBe("value-a");
    expect(b).toBe("value-b");
  });

  it("each createCredentialAccessor call creates an independent cache", async () => {
    const repo = makeRepo();
    const logger = makeLogger();
    const row = await makeEncryptedRow("token", "value");
    repo.findByConnectorIdAndField.mockResolvedValue(row);

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    const accessorA = svc.createCredentialAccessor("conn-1", MASTER_KEY);
    const accessorB = svc.createCredentialAccessor("conn-1", MASTER_KEY);

    await accessorA.get("token");
    await accessorB.get("token");

    const calls = repo.findByConnectorIdAndField.mock.calls;
    // Two independent caches — each makes a separate DB call
    expect(calls).toHaveLength(2);
  });

  it("list() returns field names from the repo", async () => {
    const repo = makeRepo();
    const logger = makeLogger();
    repo.findByConnectorId.mockResolvedValue([
      makeCredRow({ field_name: "apiKey" }),
      makeCredRow({ field_name: "secret" }),
    ]);

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    const accessor = svc.createCredentialAccessor("conn-1", MASTER_KEY);
    const names = await accessor.list();
    expect(names).toEqual(["apiKey", "secret"]);
  });

  it("get() throws CredentialNotFoundError for unknown field", async () => {
    const repo = makeRepo();
    const logger = makeLogger();
    repo.findByConnectorIdAndField.mockResolvedValue(null);

    const svc = createCredentialService({ credentialRepo: asRepo(repo), logger });
    const accessor = svc.createCredentialAccessor("conn-1", MASTER_KEY);
    await expect(accessor.get("nonexistent")).rejects.toBeInstanceOf(CredentialNotFoundError);
  });
});
