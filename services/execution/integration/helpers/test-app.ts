// Import from compiled dist/ — required for runMigrations() path resolution (B5)
import { createServiceApp } from "../../dist/index.js";

/**
 * Creates a Level 1 test instance of the execution service.
 *
 * IMPORTANT: The execution service connects to a sandbox Unix socket during
 * startup (connectToSandbox). Level 1 tests that call buildTestApp() require
 * the sandbox socket to be available at sandboxSocketPath. In practice, Level 1
 * tests for the execution service are limited to health/route shape tests where
 * the sandbox dependency is acceptable, or the test environment must supply the
 * socket (e.g., via a mock socket server in beforeAll).
 *
 * Level 2/3 tests are the primary vehicle for execution service integration
 * testing since they start the full process including the sandbox container.
 */
export async function buildTestApp() {
  const { app, cleanup } = await createServiceApp({
    databaseUrl: process.env["OP_DATABASE_URL"]!,
    jwtSecret: process.env["OP_JWT_SECRET"]!,
    masterKey: Buffer.from(process.env["OP_MASTER_KEY"]!, "base64"),
    allowedOrigins: ["http://localhost:3000"],
    // Tests must provide a valid socket path or a mock socket server
    sandboxSocketPath: process.env["OP_SANDBOX_SOCKET_PATH"] ?? "/run/sandbox/op.sock",
    pluginServiceUrl: "http://localhost:13008",
    ingestionServiceUrl: "http://localhost:13002",
    pipelineServiceUrl: "http://localhost:13004",
    serviceBaseUrl: "http://localhost:13005",
    serviceToken: process.env["OP_SERVICE_TOKEN_SECRET"] ?? "test-service-token",
    retentionDays: 7,
  });

  return { app, cleanup };
}
