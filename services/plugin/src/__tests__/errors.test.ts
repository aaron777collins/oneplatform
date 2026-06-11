// Unit tests for services/errors.ts
//
// Verifies all 19 plugin error classes have the correct code, statusCode,
// message propagation, details payload propagation, AppError/Error inheritance,
// and correct name property.

import { describe, it, expect } from "vitest";
import { AppError } from "@oneplatform/core";
import {
  InvalidManifestError,
  ChecksumMismatchError,
  GpgVerificationFailedError,
  GpgSignatureMissingError,
  InvalidPackageStructureError,
  EntrypointNotCallableError,
  PlatformVersionTooOldError,
  CircularDependencyError,
  UploadTooLargeError,
  PluginNotFoundError,
  InstanceNotFoundError,
  PluginNotActiveError,
  ConfigValidationFailedError,
  ConfigMigrationRequiredError,
  PluginHasActiveInstancesError,
  PluginHasActiveJobsError,
  OrphanConfirmationRequiredError,
  ConnectorRegistrationFailedError,
  ExecutionValidationFailedError,
  StorageUnavailableError,
  InternalPluginError,
} from "../services/errors.js";

// ---------------------------------------------------------------------------
// Helper — standard contract tests for each error class
// ---------------------------------------------------------------------------

function assertErrorContract(
  ErrorClass: new (message: string) => AppError,
  expectedCode: string,
  expectedStatusCode: number,
): void {
  const message = `Test message for ${expectedCode}`;
  const err = new ErrorClass(message);

  it(`${ErrorClass.name} — code is '${expectedCode}'`, () => {
    expect(err.code).toBe(expectedCode);
  });

  it(`${ErrorClass.name} — statusCode is ${expectedStatusCode}`, () => {
    expect(err.statusCode).toBe(expectedStatusCode);
  });

  it(`${ErrorClass.name} — message is propagated`, () => {
    expect(err.message).toBe(message);
  });

  it(`${ErrorClass.name} — instanceof AppError`, () => {
    expect(err).toBeInstanceOf(AppError);
  });

  it(`${ErrorClass.name} — instanceof Error`, () => {
    expect(err).toBeInstanceOf(Error);
  });

  it(`${ErrorClass.name} — name matches constructor`, () => {
    expect(err.name).toBe(ErrorClass.name);
  });

  it(`${ErrorClass.name} — toApiError returns spec-compliant envelope`, () => {
    const envelope = err.toApiError("req-plugin-test");
    expect(envelope).toMatchObject({
      error: {
        code: expectedCode,
        message,
        requestId: "req-plugin-test",
      },
    });
  });
}

// ---------------------------------------------------------------------------
// 422 validation errors
// ---------------------------------------------------------------------------

describe("InvalidManifestError", () => {
  assertErrorContract(InvalidManifestError, "INVALID_MANIFEST", 422);
});

describe("ChecksumMismatchError", () => {
  assertErrorContract(ChecksumMismatchError, "CHECKSUM_MISMATCH", 422);
});

describe("GpgVerificationFailedError", () => {
  assertErrorContract(GpgVerificationFailedError, "GPG_VERIFICATION_FAILED", 422);
});

describe("GpgSignatureMissingError", () => {
  assertErrorContract(GpgSignatureMissingError, "GPG_SIGNATURE_MISSING", 422);
});

describe("InvalidPackageStructureError", () => {
  assertErrorContract(InvalidPackageStructureError, "INVALID_PACKAGE_STRUCTURE", 422);
});

describe("EntrypointNotCallableError", () => {
  assertErrorContract(EntrypointNotCallableError, "ENTRYPOINT_NOT_CALLABLE", 422);
});

describe("PlatformVersionTooOldError", () => {
  assertErrorContract(PlatformVersionTooOldError, "PLATFORM_VERSION_TOO_OLD", 422);
});

describe("CircularDependencyError", () => {
  assertErrorContract(CircularDependencyError, "CIRCULAR_DEPENDENCY", 422);
});

describe("PluginNotActiveError", () => {
  assertErrorContract(PluginNotActiveError, "PLUGIN_NOT_ACTIVE", 422);
});

describe("ConfigValidationFailedError", () => {
  assertErrorContract(ConfigValidationFailedError, "CONFIG_VALIDATION_FAILED", 422);
});

describe("ConfigMigrationRequiredError", () => {
  assertErrorContract(ConfigMigrationRequiredError, "CONFIG_MIGRATION_REQUIRED", 422);
});

describe("PluginHasActiveInstancesError", () => {
  assertErrorContract(PluginHasActiveInstancesError, "PLUGIN_HAS_ACTIVE_INSTANCES", 422);
});

describe("PluginHasActiveJobsError", () => {
  assertErrorContract(PluginHasActiveJobsError, "PLUGIN_HAS_ACTIVE_JOBS", 422);
});

// ---------------------------------------------------------------------------
// 413 payload too large
// ---------------------------------------------------------------------------

describe("UploadTooLargeError", () => {
  assertErrorContract(UploadTooLargeError, "UPLOAD_TOO_LARGE", 413);
});

// ---------------------------------------------------------------------------
// 404 not found
// ---------------------------------------------------------------------------

describe("PluginNotFoundError", () => {
  assertErrorContract(PluginNotFoundError, "PLUGIN_NOT_FOUND", 404);
});

describe("InstanceNotFoundError", () => {
  assertErrorContract(InstanceNotFoundError, "INSTANCE_NOT_FOUND", 404);
});

// ---------------------------------------------------------------------------
// 409 conflict
// ---------------------------------------------------------------------------

describe("OrphanConfirmationRequiredError", () => {
  assertErrorContract(OrphanConfirmationRequiredError, "ORPHAN_CONFIRMATION_REQUIRED", 409);
});

// ---------------------------------------------------------------------------
// 502 upstream failure
// ---------------------------------------------------------------------------

describe("ConnectorRegistrationFailedError", () => {
  assertErrorContract(ConnectorRegistrationFailedError, "CONNECTOR_REGISTRATION_FAILED", 502);
});

describe("ExecutionValidationFailedError", () => {
  assertErrorContract(ExecutionValidationFailedError, "EXECUTION_VALIDATION_FAILED", 502);
});

// ---------------------------------------------------------------------------
// 503 infrastructure unavailable
// ---------------------------------------------------------------------------

describe("StorageUnavailableError", () => {
  assertErrorContract(StorageUnavailableError, "STORAGE_UNAVAILABLE", 503);
});

// ---------------------------------------------------------------------------
// 500 catch-all
// ---------------------------------------------------------------------------

describe("InternalPluginError", () => {
  assertErrorContract(InternalPluginError, "INTERNAL_ERROR", 500);
});

// ---------------------------------------------------------------------------
// Details payload propagation
// ---------------------------------------------------------------------------

describe("error details propagation", () => {
  it("InvalidManifestError carries fieldErrors in details", () => {
    const details = { fieldErrors: { id: ["Must be reverse-domain format"] } };
    const err = new InvalidManifestError("Manifest invalid", details);
    expect(err.details).toEqual(details);
  });

  it("ChecksumMismatchError carries expected/actual in details", () => {
    const details = {
      expected: "a".repeat(64),
      actual: "b".repeat(64),
      source: "manifest.bundleChecksum vs bundle.js content",
    };
    const err = new ChecksumMismatchError("Checksum mismatch", details);
    expect(err.details).toEqual(details);
    const envelope = err.toApiError("req-checksum");
    expect(envelope.error.details).toEqual(details);
  });

  it("OrphanConfirmationRequiredError carries entityTypes and totalRecords", () => {
    const details = {
      entityTypes: ["ontology-records"],
      totalRecords: 42,
      message: "42 records will be orphaned",
    };
    const err = new OrphanConfirmationRequiredError("Confirm orphan", details);
    expect(err.details).toEqual(details);
  });

  it("PluginNotFoundError carries pluginId in details", () => {
    const details = { pluginId: "com.example.my-plugin" };
    const err = new PluginNotFoundError("Plugin not found", details);
    expect(err.details).toEqual(details);
  });

  it("PluginHasActiveInstancesError carries instance count in details", () => {
    const details = { activeInstanceCount: 3 };
    const err = new PluginHasActiveInstancesError("Has active instances", details);
    expect(err.details).toEqual(details);
  });

  it("StorageUnavailableError details appear in toApiError envelope", () => {
    const details = { endpoint: "http://minio:9000" };
    const err = new StorageUnavailableError("MinIO down", details);
    const envelope = err.toApiError("req-storage");
    expect(envelope.error.details).toEqual(details);
  });

  it("error without details has no details key in envelope", () => {
    const err = new PluginNotFoundError("Not found");
    const envelope = err.toApiError("req-no-details");
    expect(envelope.error).not.toHaveProperty("details");
  });

  it("InstanceNotFoundError without details has no details key", () => {
    const err = new InstanceNotFoundError("Not found");
    const envelope = err.toApiError("req-instance");
    expect(envelope.error).not.toHaveProperty("details");
  });
});

// ---------------------------------------------------------------------------
// Prototype chain integrity
// ---------------------------------------------------------------------------

describe("prototype chain integrity", () => {
  it("all 21 error instances pass instanceof AppError at runtime", () => {
    const instances: AppError[] = [
      new InvalidManifestError("e"),
      new ChecksumMismatchError("e"),
      new GpgVerificationFailedError("e"),
      new GpgSignatureMissingError("e"),
      new InvalidPackageStructureError("e"),
      new EntrypointNotCallableError("e"),
      new PlatformVersionTooOldError("e"),
      new CircularDependencyError("e"),
      new UploadTooLargeError("e"),
      new PluginNotFoundError("e"),
      new InstanceNotFoundError("e"),
      new PluginNotActiveError("e"),
      new ConfigValidationFailedError("e"),
      new ConfigMigrationRequiredError("e"),
      new PluginHasActiveInstancesError("e"),
      new PluginHasActiveJobsError("e"),
      new OrphanConfirmationRequiredError("e"),
      new ConnectorRegistrationFailedError("e"),
      new ExecutionValidationFailedError("e"),
      new StorageUnavailableError("e"),
      new InternalPluginError("e"),
    ];
    for (const instance of instances) {
      expect(instance).toBeInstanceOf(AppError);
      expect(instance).toBeInstanceOf(Error);
    }
  });

  it("instanceof check correctly distinguishes PluginNotFoundError from InstanceNotFoundError", () => {
    const e = new PluginNotFoundError("e");
    expect(e).toBeInstanceOf(PluginNotFoundError);
    expect(e).not.toBeInstanceOf(InstanceNotFoundError);
  });

  it("instanceof check correctly distinguishes ChecksumMismatchError from GpgVerificationFailedError", () => {
    const e = new ChecksumMismatchError("e");
    expect(e).toBeInstanceOf(ChecksumMismatchError);
    expect(e).not.toBeInstanceOf(GpgVerificationFailedError);
  });

  it("instanceof check correctly distinguishes ConnectorRegistrationFailedError from ExecutionValidationFailedError", () => {
    const e = new ConnectorRegistrationFailedError("e");
    expect(e).toBeInstanceOf(ConnectorRegistrationFailedError);
    expect(e).not.toBeInstanceOf(ExecutionValidationFailedError);
  });
});

// ---------------------------------------------------------------------------
// Stack trace presence
// ---------------------------------------------------------------------------

describe("stack trace", () => {
  it("PluginNotFoundError has a non-empty stack trace", () => {
    const err = new PluginNotFoundError("test");
    expect(err.stack).toBeTruthy();
  });

  it("ChecksumMismatchError stack trace contains the error class name", () => {
    const err = new ChecksumMismatchError("test");
    expect(err.stack).toContain("ChecksumMismatchError");
  });

  it("StorageUnavailableError stack trace is a string", () => {
    const err = new StorageUnavailableError("test");
    expect(typeof err.stack).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Code property stability
// ---------------------------------------------------------------------------

describe("code property stability", () => {
  it("InvalidManifestError code is always INVALID_MANIFEST across instances", () => {
    const a = new InvalidManifestError("first");
    const b = new InvalidManifestError("second");
    expect(a.code).toBe("INVALID_MANIFEST");
    expect(b.code).toBe("INVALID_MANIFEST");
  });

  it("PluginNotFoundError code is always PLUGIN_NOT_FOUND", () => {
    const err = new PluginNotFoundError("msg");
    expect(err.code).toBe("PLUGIN_NOT_FOUND");
  });

  it("OrphanConfirmationRequiredError code is always ORPHAN_CONFIRMATION_REQUIRED", () => {
    const err = new OrphanConfirmationRequiredError("msg");
    expect(err.code).toBe("ORPHAN_CONFIRMATION_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// Status code grouping correctness
// ---------------------------------------------------------------------------

describe("status code grouping", () => {
  const status422Errors = [
    new InvalidManifestError("e"),
    new ChecksumMismatchError("e"),
    new GpgVerificationFailedError("e"),
    new GpgSignatureMissingError("e"),
    new InvalidPackageStructureError("e"),
    new EntrypointNotCallableError("e"),
    new PlatformVersionTooOldError("e"),
    new CircularDependencyError("e"),
    new PluginNotActiveError("e"),
    new ConfigValidationFailedError("e"),
    new ConfigMigrationRequiredError("e"),
    new PluginHasActiveInstancesError("e"),
    new PluginHasActiveJobsError("e"),
  ] as const;

  it("all business-rule errors have statusCode 422", () => {
    for (const err of status422Errors) {
      expect(err.statusCode).toBe(422);
    }
  });

  it("UploadTooLargeError has statusCode 413", () => {
    expect(new UploadTooLargeError("e").statusCode).toBe(413);
  });

  it("not-found errors have statusCode 404", () => {
    expect(new PluginNotFoundError("e").statusCode).toBe(404);
    expect(new InstanceNotFoundError("e").statusCode).toBe(404);
  });

  it("OrphanConfirmationRequiredError has statusCode 409", () => {
    expect(new OrphanConfirmationRequiredError("e").statusCode).toBe(409);
  });

  it("upstream-failure errors have statusCode 502", () => {
    expect(new ConnectorRegistrationFailedError("e").statusCode).toBe(502);
    expect(new ExecutionValidationFailedError("e").statusCode).toBe(502);
  });

  it("StorageUnavailableError has statusCode 503", () => {
    expect(new StorageUnavailableError("e").statusCode).toBe(503);
  });

  it("InternalPluginError has statusCode 500", () => {
    expect(new InternalPluginError("e").statusCode).toBe(500);
  });
});
