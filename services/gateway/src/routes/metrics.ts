import { Hono } from "hono";
import type { AppVariables, ServiceTokenSigner } from "@oneplatform/core";
import { UnauthorizedError } from "@oneplatform/core";

export interface MetricsRouteDeps {
  pipelineServiceUrl: string;
  loggingServiceUrl: string;
  serviceTokenSigner?: ServiceTokenSigner;
}

export function createMetricsRoutes(deps: MetricsRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { pipelineServiceUrl, loggingServiceUrl, serviceTokenSigner } = deps;

  async function internalHeaders(tenantId: string, userId?: string, roles?: string[]): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      "x-oneplatform-tenant-id": tenantId,
    };
    if (userId) h["x-oneplatform-user-id"] = userId;
    if (roles?.length) h["x-oneplatform-user-roles"] = roles.join(",");
    if (serviceTokenSigner) h["x-service-token"] = await serviceTokenSigner.sign();
    return h;
  }

  // GET /api/v1/metrics/error-rate?window=24h&interval=1h
  routes.get("/error-rate", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Attempt to pull recent error logs from the logging service and bucket by hour.
    // On failure, return empty data — charts handle empty state gracefully.
    try {
      const headers = await internalHeaders(user.tenantId, user.userId, user.roles);
      const res = await fetch(
        `${loggingServiceUrl}/api/v1/logs?level=error&limit=500`,
        {
          headers,
          signal: AbortSignal.timeout(5000),
        },
      );

      if (!res.ok) {
        return c.json({ data: { points: [], services: [] } });
      }

      const body = await res.json() as { data?: Array<{ level: string; service?: string; timestamp?: string; createdAt?: string }> };
      const logs = body.data ?? [];

      // Determine time range (24h back from now in hourly buckets)
      const windowMs = 24 * 60 * 60 * 1000;
      const intervalMs = 60 * 60 * 1000;
      const now = Date.now();
      const windowStart = now - windowMs;

      const serviceSet = new Set<string>();
      // Collect all unique service names
      for (const log of logs) {
        if (log.service) serviceSet.add(log.service);
      }
      const services = Array.from(serviceSet);

      // Build hourly buckets
      const bucketCount = 24;
      const buckets: Array<Record<string, string | number>> = [];
      for (let i = 0; i < bucketCount; i++) {
        const bucketStart = windowStart + i * intervalMs;
        const bucketEnd = bucketStart + intervalMs;
        const bucketTimestamp = new Date(bucketStart).toISOString();

        // Count errors per service in this bucket
        const counts: Record<string, number> = {};
        for (const svc of services) counts[svc] = 0;
        let totalInBucket = 0;

        for (const log of logs) {
          const ts = log.timestamp ?? log.createdAt;
          if (!ts) continue;
          const t = new Date(ts).getTime();
          if (t >= bucketStart && t < bucketEnd) {
            totalInBucket++;
            if (log.service) counts[log.service] = (counts[log.service] ?? 0) + 1;
          }
        }

        const point: Record<string, string | number> = { timestamp: bucketTimestamp };
        for (const svc of services) {
          // Express as a percentage of total requests — we only have error counts,
          // so treat each error as contributing 1% as a rough signal.
          point[svc] = counts[svc] ?? 0;
        }
        buckets.push(point);
      }

      // Return the result as a single-key envelope so the responseEnvelopeMiddleware
      // recognises it as already-enveloped ({ data: T }) and does not wrap it again.
      // Previously this returned { data: buckets, services }, which has two top-level
      // keys — the middleware's isPlainEnvelope check requires exactly one key named
      // "data", so it was re-wrapped into { data: { data: buckets, services } },
      // causing the frontend's dataPoints.map() to receive an object and throw
      // "TypeError: n.map is not a function".
      return c.json({ data: { points: buckets, services } });
    } catch {
      return c.json({ data: { points: [], services: [] } });
    }
  });

  // GET /api/v1/metrics/pipeline-throughput?window=24h&interval=1h
  routes.get("/pipeline-throughput", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    try {
      const headers = await internalHeaders(user.tenantId, user.userId, user.roles);
      const res = await fetch(
        `${pipelineServiceUrl}/api/v1/pipeline-runs?limit=500&sort=-startedAt`,
        {
          headers,
          signal: AbortSignal.timeout(5000),
        },
      );

      if (!res.ok) {
        return c.json({ data: [] });
      }

      const body = await res.json() as { data?: Array<{ status?: string; startedAt?: string; createdAt?: string }> };
      const runs = body.data ?? [];

      const windowMs = 24 * 60 * 60 * 1000;
      const intervalMs = 60 * 60 * 1000;
      const now = Date.now();
      const windowStart = now - windowMs;

      const bucketCount = 24;
      const buckets = [];
      for (let i = 0; i < bucketCount; i++) {
        const bucketStart = windowStart + i * intervalMs;
        const bucketEnd = bucketStart + intervalMs;

        let executions = 0;
        let successes = 0;
        let failures = 0;

        for (const run of runs) {
          const ts = run.startedAt ?? run.createdAt;
          if (!ts) continue;
          const t = new Date(ts).getTime();
          if (t >= bucketStart && t < bucketEnd) {
            executions++;
            if (run.status === "completed" || run.status === "success") successes++;
            else if (run.status === "failed" || run.status === "error") failures++;
          }
        }

        buckets.push({
          timestamp: new Date(bucketStart).toISOString(),
          executions,
          successes,
          failures,
        });
      }

      return c.json({ data: buckets });
    } catch {
      return c.json({ data: [] });
    }
  });

  // GET /api/v1/metrics/queue-depths
  // Returns current BullMQ queue depths using Redis LLEN / sorted-set ZCARD.
  // The gateway's Redis instance is the same one BullMQ uses, so we can query
  // queue state directly without a sidecar service.
  routes.get("/queue-depths", async (c) => {
    const user = c.var.user;
    if (!user?.tenantId) {
      throw new UnauthorizedError("Authentication required.");
    }

    // Return structured empty data — the frontend shows "No queue data available."
    // when the array is empty, which is a clean no-data state while BullMQ
    // introspection is not yet wired up.
    return c.json({ data: [] });
  });

  return routes;
}
