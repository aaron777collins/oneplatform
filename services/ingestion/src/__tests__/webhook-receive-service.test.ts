// Unit tests for services/ingestion/src/services/webhook-receive-service.ts
//
// Tests LRU cache behaviour, HMAC verification, anti-enumeration (always 200),
// and event processing paths.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { Logger } from "@oneplatform/core";
import {
  createWebhookReceiveService,
  type WebhookReceiverRepository,
  type WebhookReceiverRow,
} from "../services/webhook-receive-service.js";
import type { CredentialService } from "../services/credential-service.js";
import type { RawTableRepository } from "../services/sync-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MASTER_KEY = Buffer.from("01234567890123456789012345678901");
const RECEIVER_ID = "10000000-0000-4000-8000-000000000011";
const TENANT_ID = "10000000-0000-4000-8000-000000000012";
const SIGNING_SECRET = "my-webhook-signing-secret";

function makeReceiverRow(overrides: Partial<WebhookReceiverRow> = {}): WebhookReceiverRow {
  return {
    id: RECEIVER_ID,
    tenant_id: TENANT_ID,
    connector_id: null,
    name: "Test Receiver",
    description: null,
    path_suffix: "path-abc",
    secret_hash: "hashed-secret",
    hmac_algorithm: "sha256",
    header_name: "X-Webhook-Signature",
    is_enabled: true,
    created_by: "user-1",
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    last_received_at: null,
    events_received: "0",
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

interface MockReceiverRepo {
  findById: MockFn; findByPathSuffix: MockFn; incrementEventsReceived: MockFn;
  findByTenantId: MockFn; findByTenantAndId: MockFn; listByTenantId: MockFn;
  countByTenantId: MockFn; create: MockFn; update: MockFn; softDelete: MockFn;
}

interface MockCredSvc {
  getDecryptedCredential: MockFn; storeCredentials: MockFn;
  listFieldNames: MockFn; deleteByConnectorId: MockFn;
  createCredentialAccessor: MockFn;
}

interface MockRawRepo {
  createRawTable: MockFn; insertBatch: MockFn; softDeleteNotInBatch: MockFn;
  deleteOlderThan: MockFn; dropTable: MockFn; count: MockFn;
}

function makeReceiverRepo(): MockReceiverRepo {
  return {
    findById: vi.fn(), findByPathSuffix: vi.fn(),
    incrementEventsReceived: vi.fn().mockResolvedValue(undefined),
    findByTenantId: vi.fn(), findByTenantAndId: vi.fn(), listByTenantId: vi.fn(),
    countByTenantId: vi.fn(), create: vi.fn(), update: vi.fn(), softDelete: vi.fn(),
  };
}

function makeCredentialService(): MockCredSvc {
  return {
    getDecryptedCredential: vi.fn().mockResolvedValue(SIGNING_SECRET),
    storeCredentials: vi.fn(), listFieldNames: vi.fn(),
    deleteByConnectorId: vi.fn(), createCredentialAccessor: vi.fn(),
  };
}

function makeRawTableRepo(): MockRawRepo {
  return {
    createRawTable: vi.fn().mockResolvedValue(undefined),
    insertBatch: vi.fn().mockResolvedValue(undefined),
    softDeleteNotInBatch: vi.fn().mockResolvedValue(0),
    deleteOlderThan: vi.fn().mockResolvedValue(0),
    dropTable: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
  };
}

function signBody(body: Buffer, secret: string, algorithm: "sha256" | "sha512" = "sha256"): string {
  return createHmac(algorithm, secret).update(body).digest("hex");
}

// BullMQ Queue is instantiated inside the service — stub it out globally.
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Helper to build the service — casts mock objects to their interface types.
function buildService(opts: {
  receiverRepo?: MockReceiverRepo;
  rawTableRepo?: MockRawRepo;
  credentialService?: MockCredSvc;
}) {
  return createWebhookReceiveService({
    receiverRepo: (opts.receiverRepo ?? makeReceiverRepo()) as unknown as WebhookReceiverRepository,
    rawTableRepo: (opts.rawTableRepo ?? makeRawTableRepo()) as unknown as RawTableRepository,
    credentialService: (opts.credentialService ?? makeCredentialService()) as unknown as CredentialService,
    masterKey: MASTER_KEY,
    logger: makeLogger(),
  });
}

// ---------------------------------------------------------------------------
// Anti-enumeration — always returns { received: true }
// ---------------------------------------------------------------------------

describe("receiveEvent — anti-enumeration (always 200)", () => {
  it("returns { received: true } when receiver does not exist in DB", async () => {
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(null);
    const svc = buildService({ receiverRepo });
    const result = await svc.receiveEvent("nonexistent-id", Buffer.from("body"), {});
    expect(result.received).toBe(true);
  });

  it("returns { received: true } when receiver is disabled", async () => {
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow({ is_enabled: false }));
    const svc = buildService({ receiverRepo });
    const result = await svc.receiveEvent(RECEIVER_ID, Buffer.from("body"), {});
    expect(result.received).toBe(true);
  });

  it("returns { received: true } when receiver is soft-deleted", async () => {
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow({ deleted_at: new Date() }));
    const svc = buildService({ receiverRepo });
    const result = await svc.receiveEvent(RECEIVER_ID, Buffer.from("body"), {});
    expect(result.received).toBe(true);
  });

  it("returns { received: true } when HMAC verification fails", async () => {
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow());
    const svc = buildService({ receiverRepo });
    const result = await svc.receiveEvent(RECEIVER_ID, Buffer.from("body"), { "x-webhook-signature": "sha256=invalidsig" });
    expect(result.received).toBe(true);
  });

  it("returns { received: true } when signing secret cannot be decrypted", async () => {
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow());
    const credentialService = makeCredentialService();
    credentialService.getDecryptedCredential.mockRejectedValue(new Error("decrypt failed"));
    const svc = buildService({ receiverRepo, credentialService });
    const result = await svc.receiveEvent(RECEIVER_ID, Buffer.from("body"), { "x-webhook-signature": "sha256=anything" });
    expect(result.received).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

describe("receiveEvent — HMAC verification", () => {
  it("accepts a correct sha256 HMAC signature", async () => {
    const body = Buffer.from(JSON.stringify({ id: "evt-1", data: "hello" }));
    const sig = signBody(body, SIGNING_SECRET, "sha256");
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow({ hmac_algorithm: "sha256" }));
    const svc = buildService({ receiverRepo });
    const result = await svc.receiveEvent(RECEIVER_ID, body, { "x-webhook-signature": sig });
    expect(result.received).toBe(true);
    expect(result.eventId).toBeDefined();
  });

  it("accepts signature with 'sha256=' prefix", async () => {
    const body = Buffer.from(JSON.stringify({ id: "evt-2" }));
    const sig = `sha256=${signBody(body, SIGNING_SECRET, "sha256")}`;
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow({ hmac_algorithm: "sha256" }));
    const svc = buildService({ receiverRepo });
    const result = await svc.receiveEvent(RECEIVER_ID, body, { "x-webhook-signature": sig });
    expect(result.received).toBe(true);
    expect(result.eventId).toBeDefined();
  });

  it("accepts a correct sha512 HMAC signature", async () => {
    const body = Buffer.from(JSON.stringify({ id: "evt-3" }));
    const sig = signBody(body, SIGNING_SECRET, "sha512");
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow({ hmac_algorithm: "sha512" }));
    const svc = buildService({ receiverRepo });
    const result = await svc.receiveEvent(RECEIVER_ID, body, { "x-webhook-signature": sig });
    expect(result.received).toBe(true);
    expect(result.eventId).toBeDefined();
  });

  it("rejects a signature that is one hex char different (timing-safe path)", async () => {
    const body = Buffer.from(JSON.stringify({ id: "evt-4" }));
    const sig = signBody(body, SIGNING_SECRET, "sha256");
    const badSig = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow({ hmac_algorithm: "sha256" }));
    const svc = buildService({ receiverRepo });
    const result = await svc.receiveEvent(RECEIVER_ID, body, { "x-webhook-signature": badSig });
    // Still returns 200 — anti-enumeration
    expect(result.received).toBe(true);
    expect(result.eventId).toBeUndefined();
  });

  it("rejects an empty signature header", async () => {
    const body = Buffer.from("body");
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow());
    const svc = buildService({ receiverRepo });
    const result = await svc.receiveEvent(RECEIVER_ID, body, {});
    expect(result.received).toBe(true);
    expect(result.eventId).toBeUndefined();
  });

  it("uses the receiver's configured headerName to extract the signature", async () => {
    const body = Buffer.from(JSON.stringify({ id: "custom-header-evt" }));
    const sig = signBody(body, SIGNING_SECRET, "sha256");
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow({ hmac_algorithm: "sha256", header_name: "X-Custom-Sig" }));
    const svc = buildService({ receiverRepo });
    const result = await svc.receiveEvent(RECEIVER_ID, body, { "x-custom-sig": sig });
    expect(result.received).toBe(true);
    expect(result.eventId).toBeDefined();
  });

  it("rejects when signature is in the wrong header", async () => {
    const body = Buffer.from(JSON.stringify({ id: "wrong-header-evt" }));
    const sig = signBody(body, SIGNING_SECRET, "sha256");
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow({ hmac_algorithm: "sha256", header_name: "X-Custom-Sig" }));
    const svc = buildService({ receiverRepo });
    const result = await svc.receiveEvent(RECEIVER_ID, body, { "x-webhook-signature": sig });
    expect(result.received).toBe(true);
    expect(result.eventId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LRU cache behaviour
// ---------------------------------------------------------------------------

describe("LRU cache", () => {
  it("uses cached receiver on second call (repo called only once)", async () => {
    const body = Buffer.from(JSON.stringify({ id: "cached-evt" }));
    const sig = signBody(body, SIGNING_SECRET, "sha256");
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow());
    const svc = buildService({ receiverRepo });
    await svc.receiveEvent(RECEIVER_ID, body, { "x-webhook-signature": sig });
    await svc.receiveEvent(RECEIVER_ID, body, { "x-webhook-signature": sig });
    expect(receiverRepo.findById.mock.calls).toHaveLength(1);
  });

  it("invalidateCache forces a fresh DB lookup on the next call", async () => {
    const body = Buffer.from(JSON.stringify({ id: "refreshed-evt" }));
    const sig = signBody(body, SIGNING_SECRET, "sha256");
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow());
    const svc = buildService({ receiverRepo });
    await svc.receiveEvent(RECEIVER_ID, body, { "x-webhook-signature": sig });
    svc.invalidateCache(RECEIVER_ID);
    await svc.receiveEvent(RECEIVER_ID, body, { "x-webhook-signature": sig });
    expect(receiverRepo.findById.mock.calls).toHaveLength(2);
  });

  it("invalidateCache for a non-existent key does not throw", () => {
    const svc = buildService({});
    expect(() => svc.invalidateCache("unknown-key")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Event processing — non-JSON body
// ---------------------------------------------------------------------------

describe("receiveEvent — non-JSON body handling", () => {
  it("wraps non-JSON body in _raw base64 field and still returns received=true", async () => {
    const body = Buffer.from("not json at all");
    const sig = signBody(body, SIGNING_SECRET, "sha256");
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow());
    const rawTableRepo = makeRawTableRepo();
    const svc = buildService({ receiverRepo, rawTableRepo });
    const result = await svc.receiveEvent(RECEIVER_ID, body, { "x-webhook-signature": sig });
    expect(result.received).toBe(true);
    expect(result.eventId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Stats — incrementEventsReceived is fire-and-forget (no thrown error)
// ---------------------------------------------------------------------------

describe("receiveEvent — stats failure does not abort", () => {
  it("resolves even when incrementEventsReceived rejects", async () => {
    const body = Buffer.from(JSON.stringify({ id: "e1" }));
    const sig = signBody(body, SIGNING_SECRET, "sha256");
    const receiverRepo = makeReceiverRepo();
    receiverRepo.findById.mockResolvedValue(makeReceiverRow());
    receiverRepo.incrementEventsReceived.mockRejectedValue(new Error("DB error"));
    const svc = buildService({ receiverRepo });
    const result = await svc.receiveEvent(RECEIVER_ID, body, { "x-webhook-signature": sig });
    expect(result.received).toBe(true);
  });
});
