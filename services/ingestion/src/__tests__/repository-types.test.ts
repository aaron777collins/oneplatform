// Compile-time and runtime assignability tests for repository types in
// services/ingestion/src/repositories/types.ts
//
// These tests verify: row shapes are assignable to their interfaces,
// optional input fields behave as expected, and union/literal constraints hold.

import { describe, it, expect } from "vitest";
import type {
  ConnectorRow,
  CredentialRow,
  SyncStateRow,
  WebhookReceiverRow,
  UploadJobRow,
  CreateConnectorData,
  UpdateConnectorData,
  CreateCredentialData,
  CreateWebhookReceiverData,
  UpdateWebhookReceiverData,
  CreateUploadJobData,
  UpdateUploadJobData,
} from "../repositories/types.js";

// ---------------------------------------------------------------------------
// ConnectorRow
// ---------------------------------------------------------------------------

describe("ConnectorRow — shape", () => {
  const row: ConnectorRow = {
    id: "c1",
    tenant_id: "t1",
    plugin_id: "stripe",
    instance_id: "i1",
    name: "Test",
    description: null,
    config: {},
    sync_mode: "incremental",
    schedule_cron: null,
    is_enabled: true,
    created_by: "user-1",
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  };

  it("has all required fields", () => {
    expect(row.id).toBeDefined();
    expect(row.tenant_id).toBeDefined();
    expect(row.plugin_id).toBeDefined();
    expect(row.instance_id).toBeDefined();
  });

  it("description can be null", () => {
    expect(row.description).toBeNull();
  });

  it("deleted_at can be null", () => {
    expect(row.deleted_at).toBeNull();
  });

  it("sync_mode is a union type 'full' | 'incremental'", () => {
    expect(["full", "incremental"]).toContain(row.sync_mode);
  });

  it("is_enabled is boolean", () => {
    expect(typeof row.is_enabled).toBe("boolean");
  });

  it("schedule_cron can be a string", () => {
    const withCron: ConnectorRow = { ...row, schedule_cron: "0 * * * *" };
    expect(withCron.schedule_cron).toBe("0 * * * *");
  });

  it("deleted_at can be a Date", () => {
    const deleted: ConnectorRow = { ...row, deleted_at: new Date() };
    expect(deleted.deleted_at).toBeInstanceOf(Date);
  });

  it("config is Record<string, unknown>", () => {
    const withConfig: ConnectorRow = { ...row, config: { key: "value", nested: { a: 1 } } };
    expect(typeof withConfig.config).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// CredentialRow
// ---------------------------------------------------------------------------

describe("CredentialRow — shape", () => {
  const row: CredentialRow = {
    id: "cr1",
    connector_id: "c1",
    field_name: "apiKey",
    encrypted_blob: "base64data",
    key_version: 1,
    created_at: new Date(),
    updated_at: new Date(),
  };

  it("has all required fields", () => {
    expect(row.id).toBeDefined();
    expect(row.connector_id).toBeDefined();
    expect(row.field_name).toBeDefined();
    expect(row.encrypted_blob).toBeDefined();
    expect(row.key_version).toBeDefined();
  });

  it("key_version is a number", () => {
    expect(typeof row.key_version).toBe("number");
  });

  it("timestamps are Date instances", () => {
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// SyncStateRow
// ---------------------------------------------------------------------------

describe("SyncStateRow — shape", () => {
  const row: SyncStateRow = {
    connector_id: "c1",
    last_cursor: null,
    last_sync_at: null,
    last_sync_job_id: null,
    sync_mode: "incremental",
    status: "never_run",
    last_error: null,
    last_error_code: null,
    rows_last_sync: "0",
    rows_total: "0",
    updated_at: new Date(),
  };

  it("has all required fields", () => {
    expect(row.connector_id).toBeDefined();
    expect(row.rows_last_sync).toBeDefined();
    expect(row.rows_total).toBeDefined();
  });

  it("rows_last_sync and rows_total are strings (pg bigint driver behaviour)", () => {
    expect(typeof row.rows_last_sync).toBe("string");
    expect(typeof row.rows_total).toBe("string");
  });

  it("status is a valid union value", () => {
    const validStatuses = ["never_run", "running", "success", "failed", "cancelled"];
    expect(validStatuses).toContain(row.status);
  });

  it("last_cursor can be a string", () => {
    const withCursor: SyncStateRow = { ...row, last_cursor: "cursor-abc" };
    expect(withCursor.last_cursor).toBe("cursor-abc");
  });

  it("last_sync_at can be a Date", () => {
    const withDate: SyncStateRow = { ...row, last_sync_at: new Date() };
    expect(withDate.last_sync_at).toBeInstanceOf(Date);
  });

  it("all nullable string fields can be non-null", () => {
    const full: SyncStateRow = {
      ...row,
      last_cursor: "cur",
      last_sync_job_id: "job-1",
      last_error: "some error",
      last_error_code: "ERR_CODE",
    };
    expect(full.last_error).toBe("some error");
  });
});

// ---------------------------------------------------------------------------
// WebhookReceiverRow
// ---------------------------------------------------------------------------

describe("WebhookReceiverRow — shape", () => {
  const row: WebhookReceiverRow = {
    id: "wr1",
    tenant_id: "t1",
    connector_id: null,
    name: "My Receiver",
    description: null,
    path_suffix: "path-abc",
    secret_hash: "hashed",
    hmac_algorithm: "sha256",
    header_name: "X-Webhook-Signature",
    is_enabled: true,
    created_by: "user-1",
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    last_received_at: null,
    events_received: "0",
  };

  it("has all required fields", () => {
    expect(row.id).toBeDefined();
    expect(row.path_suffix).toBeDefined();
    expect(row.secret_hash).toBeDefined();
    expect(row.hmac_algorithm).toBeDefined();
  });

  it("hmac_algorithm is 'sha256' | 'sha512'", () => {
    expect(["sha256", "sha512"]).toContain(row.hmac_algorithm);
  });

  it("events_received is a string (pg bigint)", () => {
    expect(typeof row.events_received).toBe("string");
  });

  it("connector_id can be a string", () => {
    const linked: WebhookReceiverRow = { ...row, connector_id: "conn-1" };
    expect(linked.connector_id).toBe("conn-1");
  });

  it("hmac_algorithm can be sha512", () => {
    const sha512: WebhookReceiverRow = { ...row, hmac_algorithm: "sha512" };
    expect(sha512.hmac_algorithm).toBe("sha512");
  });
});

// ---------------------------------------------------------------------------
// UploadJobRow
// ---------------------------------------------------------------------------

describe("UploadJobRow — shape", () => {
  const row: UploadJobRow = {
    id: "uj1",
    tenant_id: "t1",
    connector_id: null,
    filename: "data.csv",
    content_type: "text/csv",
    file_size_bytes: null,
    minio_key: null,
    status: "uploading",
    rows_parsed: "0",
    rows_staged: "0",
    rows_failed: "0",
    error: null,
    inferred_schema: null,
    created_by: "user-1",
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
  };

  it("has all required fields", () => {
    expect(row.id).toBeDefined();
    expect(row.filename).toBeDefined();
    expect(row.content_type).toBeDefined();
    expect(row.status).toBeDefined();
  });

  it("status is one of the allowed values", () => {
    const valid = ["pending", "uploading", "parsing", "staging", "complete", "failed"];
    expect(valid).toContain(row.status);
  });

  it("rows_parsed, rows_staged, rows_failed are strings (pg bigint)", () => {
    expect(typeof row.rows_parsed).toBe("string");
    expect(typeof row.rows_staged).toBe("string");
    expect(typeof row.rows_failed).toBe("string");
  });

  it("file_size_bytes can be a string", () => {
    const withSize: UploadJobRow = { ...row, file_size_bytes: "1048576" };
    expect(withSize.file_size_bytes).toBe("1048576");
  });

  it("inferred_schema can be a record", () => {
    const withSchema: UploadJobRow = { ...row, inferred_schema: { fields: [] } };
    expect(withSchema.inferred_schema).toEqual({ fields: [] });
  });

  it("completed_at can be a Date", () => {
    const completed: UploadJobRow = { ...row, completed_at: new Date() };
    expect(completed.completed_at).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// CreateConnectorData
// ---------------------------------------------------------------------------

describe("CreateConnectorData — input shape", () => {
  it("accepts a minimal create payload", () => {
    const data: CreateConnectorData = {
      tenant_id: "t1",
      plugin_id: "stripe",
      instance_id: "i1",
      name: "Test",
      config: {},
      created_by: "user-1",
    };
    expect(data.tenant_id).toBe("t1");
  });

  it("accepts optional description", () => {
    const data: CreateConnectorData = {
      tenant_id: "t1",
      plugin_id: "stripe",
      instance_id: "i1",
      name: "Test",
      config: {},
      created_by: "user-1",
      description: "optional field",
    };
    expect(data.description).toBe("optional field");
  });

  it("accepts optional sync_mode", () => {
    const data: CreateConnectorData = {
      tenant_id: "t1",
      plugin_id: "stripe",
      instance_id: "i1",
      name: "Test",
      config: {},
      created_by: "user-1",
      sync_mode: "full",
    };
    expect(data.sync_mode).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// UpdateConnectorData
// ---------------------------------------------------------------------------

describe("UpdateConnectorData — input shape", () => {
  it("accepts an empty update (all optional)", () => {
    const data: UpdateConnectorData = {};
    expect(data.name).toBeUndefined();
  });

  it("accepts description = null to clear the field", () => {
    const data: UpdateConnectorData = { description: null };
    expect(data.description).toBeNull();
  });

  it("accepts schedule_cron = null to clear the schedule", () => {
    const data: UpdateConnectorData = { schedule_cron: null };
    expect(data.schedule_cron).toBeNull();
  });

  it("accepts is_enabled = false to disable", () => {
    const data: UpdateConnectorData = { is_enabled: false };
    expect(data.is_enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CreateCredentialData
// ---------------------------------------------------------------------------

describe("CreateCredentialData — input shape", () => {
  it("has all required fields", () => {
    const data: CreateCredentialData = {
      connector_id: "c1",
      field_name: "apiKey",
      encrypted_blob: "blob",
      key_version: 1,
    };
    expect(data.key_version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CreateWebhookReceiverData
// ---------------------------------------------------------------------------

describe("CreateWebhookReceiverData — input shape", () => {
  it("accepts a minimal create payload", () => {
    const data: CreateWebhookReceiverData = {
      tenant_id: "t1",
      name: "My Receiver",
      path_suffix: "path-abc",
      secret_hash: "hashed",
      created_by: "user-1",
    };
    expect(data.name).toBe("My Receiver");
  });

  it("accepts optional connector_id", () => {
    const data: CreateWebhookReceiverData = {
      tenant_id: "t1",
      name: "R",
      path_suffix: "p",
      secret_hash: "h",
      created_by: "u",
      connector_id: "c1",
    };
    expect(data.connector_id).toBe("c1");
  });

  it("accepts optional hmac_algorithm", () => {
    const data: CreateWebhookReceiverData = {
      tenant_id: "t1",
      name: "R",
      path_suffix: "p",
      secret_hash: "h",
      created_by: "u",
      hmac_algorithm: "sha512",
    };
    expect(data.hmac_algorithm).toBe("sha512");
  });
});

// ---------------------------------------------------------------------------
// UpdateWebhookReceiverData
// ---------------------------------------------------------------------------

describe("UpdateWebhookReceiverData — input shape", () => {
  it("accepts an empty update", () => {
    const data: UpdateWebhookReceiverData = {};
    expect(data.name).toBeUndefined();
  });

  it("accepts description = null to clear the field", () => {
    const data: UpdateWebhookReceiverData = { description: null };
    expect(data.description).toBeNull();
  });

  it("accepts connector_id = null to unlink", () => {
    const data: UpdateWebhookReceiverData = { connector_id: null };
    expect(data.connector_id).toBeNull();
  });

  it("accepts secret_hash for rotation", () => {
    const data: UpdateWebhookReceiverData = { secret_hash: "new-hash" };
    expect(data.secret_hash).toBe("new-hash");
  });
});

// ---------------------------------------------------------------------------
// CreateUploadJobData
// ---------------------------------------------------------------------------

describe("CreateUploadJobData — input shape", () => {
  it("accepts required fields", () => {
    const data: CreateUploadJobData = {
      tenant_id: "t1",
      filename: "f.csv",
      content_type: "text/csv",
      created_by: "user-1",
    };
    expect(data.tenant_id).toBe("t1");
  });

  it("accepts optional file_size_bytes", () => {
    const data: CreateUploadJobData = {
      tenant_id: "t1",
      filename: "f.csv",
      content_type: "text/csv",
      created_by: "user-1",
      file_size_bytes: 1024,
    };
    expect(data.file_size_bytes).toBe(1024);
  });

  it("accepts optional status", () => {
    const data: CreateUploadJobData = {
      tenant_id: "t1",
      filename: "f.csv",
      content_type: "text/csv",
      created_by: "user-1",
      status: "uploading",
    };
    expect(data.status).toBe("uploading");
  });
});

// ---------------------------------------------------------------------------
// UpdateUploadJobData
// ---------------------------------------------------------------------------

describe("UpdateUploadJobData — input shape", () => {
  it("accepts an empty update", () => {
    const data: UpdateUploadJobData = {};
    expect(data.status).toBeUndefined();
  });

  it("accepts error = null to clear the error field", () => {
    const data: UpdateUploadJobData = { error: null };
    expect(data.error).toBeNull();
  });

  it("accepts inferred_schema", () => {
    const data: UpdateUploadJobData = { inferred_schema: { fields: ["id", "name"] } };
    expect(data.inferred_schema).toBeDefined();
  });

  it("accepts all row counter fields", () => {
    const data: UpdateUploadJobData = {
      rows_parsed: 1000,
      rows_staged: 990,
      rows_failed: 10,
    };
    expect(data.rows_parsed).toBe(1000);
    expect(data.rows_staged).toBe(990);
    expect(data.rows_failed).toBe(10);
  });
});
