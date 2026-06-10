import { describe, it, expect, vi } from "vitest";

vi.mock("pg", () => {
  const Pool = vi.fn().mockImplementation((config) => ({ _config: config }));
  return { default: { Pool }, Pool };
});

describe("createDbClient", () => {
  it("constructs pool with connection string and correct limits", async () => {
    const { createDbClient } = await import("../db.js");
    const pool = createDbClient({
      connectionString: "postgres://user:pass@pgbouncer:5433/op",
      maxConnections: 20,
    });
    // @ts-expect-error — accessing mock internals
    expect(pool._config.connectionString).toBe(
      "postgres://user:pass@pgbouncer:5433/op"
    );
    // @ts-expect-error
    expect(pool._config.max).toBe(20);
  });

  it("sets statement_timeout to prevent runaway queries", async () => {
    const { createDbClient } = await import("../db.js");
    const pool = createDbClient({
      connectionString: "postgres://user:pass@pgbouncer:5433/op",
      maxConnections: 10,
    });
    // @ts-expect-error
    expect(pool._config.statement_timeout).toBeGreaterThan(0);
  });
});
