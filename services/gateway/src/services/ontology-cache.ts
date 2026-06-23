import type { Redis } from "ioredis";
import type { Logger, ServiceTokenSigner } from "@oneplatform/core";

export interface EntityDefinition {
  id: string;
  name: string;
  slug: string;
  version: number;
  isPublic: boolean;
  fields: Array<{
    slug: string;
    fieldType: string;
    required: boolean;
    nullable: boolean;
  }>;
}

export interface OntologyCacheEntry {
  tenantId: string;
  schemaVersion: number;
  entities: Map<string, EntityDefinition>;
  lastFetchedAt: Date;
  etag: string;
}

export interface OntologyCache {
  getEntry(tenantId: string): OntologyCacheEntry | undefined;
  getEntity(tenantId: string, entityType: string): EntityDefinition | undefined;
  getAllEntityTypes(tenantId: string): string[];
  refresh(tenantId: string): Promise<void>;
  refreshAll(): Promise<void>;
  startSafetyPoll(): void;
  stopSafetyPoll(): void;
  startPubSubListener(redis: Redis): void;
  stopPubSubListener(): void;
}

export interface OntologyCacheDeps {
  logger: Logger;
  ontologyServiceUrl: string;
  serviceTokenSigner?: ServiceTokenSigner;
}

const SAFETY_POLL_INTERVAL_MS = 5 * 60 * 1000;

export function createOntologyCache(deps: OntologyCacheDeps): OntologyCache {
  const { logger, ontologyServiceUrl } = deps;

  const cache = new Map<string, OntologyCacheEntry>();
  let safetyPollTimer: ReturnType<typeof setInterval> | null = null;
  let pubsubRedis: Redis | null = null;

  async function fetchSnapshot(tenantId: string, etag?: string): Promise<{
    snapshot: {
      tenantId: string;
      schemaVersion: number;
      etag: string;
      entities: Array<{
        id: string;
        name: string;
        slug: string;
        version: number;
        isPublic: boolean;
        fields: Array<{ slug: string; fieldType: string; required: boolean; nullable: boolean }>;
      }>;
    } | null;
    notModified: boolean;
  }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (deps.serviceTokenSigner !== undefined) {
      headers["X-Service-Token"] = await deps.serviceTokenSigner.sign();
    }
    if (etag) {
      headers["If-None-Match"] = etag;
    }

    const response = await fetch(
      `${ontologyServiceUrl}/internal/ontology/schema?tenantId=${encodeURIComponent(tenantId)}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );

    if (response.status === 304) {
      return { snapshot: null, notModified: true };
    }

    if (!response.ok) {
      throw new Error(`Ontology schema fetch failed: HTTP ${response.status}`);
    }

    const snapshot = await response.json() as {
      tenantId: string;
      schemaVersion: number;
      etag: string;
      entities: Array<{
        id: string;
        name: string;
        slug: string;
        version: number;
        isPublic: boolean;
        fields: Array<{ slug: string; fieldType: string; required: boolean; nullable: boolean }>;
      }>;
    };
    return { snapshot, notModified: false };
  }

  function applySnapshot(snapshot: NonNullable<Awaited<ReturnType<typeof fetchSnapshot>>["snapshot"]>): void {
    const entityMap = new Map<string, EntityDefinition>();
    for (const e of snapshot.entities) {
      entityMap.set(e.slug, {
        id: e.id,
        name: e.name,
        slug: e.slug,
        version: e.version,
        isPublic: e.isPublic,
        fields: e.fields,
      });
    }

    cache.set(snapshot.tenantId, {
      tenantId: snapshot.tenantId,
      schemaVersion: snapshot.schemaVersion,
      entities: entityMap,
      lastFetchedAt: new Date(),
      etag: snapshot.etag,
    });
  }

  return {
    getEntry(tenantId) {
      return cache.get(tenantId);
    },

    getEntity(tenantId, entityType) {
      return cache.get(tenantId)?.entities.get(entityType);
    },

    getAllEntityTypes(tenantId) {
      const entry = cache.get(tenantId);
      if (!entry) return [];
      return Array.from(entry.entities.keys());
    },

    async refresh(tenantId) {
      try {
        const existing = cache.get(tenantId);
        const { snapshot, notModified } = await fetchSnapshot(
          tenantId,
          existing?.etag,
        );
        if (!notModified && snapshot) {
          applySnapshot(snapshot);
          logger.debug(`Refreshed ontology cache for tenant ${tenantId}`);
        }
      } catch (err) {
        logger.warn(`Failed to refresh ontology cache for tenant ${tenantId}: ${String(err)}`);
      }
    },

    async refreshAll() {
      const tenantIds = Array.from(cache.keys());
      await Promise.allSettled(tenantIds.map((id) => this.refresh(id)));
    },

    startSafetyPoll() {
      if (safetyPollTimer) return;
      safetyPollTimer = setInterval(() => {
        void this.refreshAll();
      }, SAFETY_POLL_INTERVAL_MS);
    },

    stopSafetyPoll() {
      if (safetyPollTimer) {
        clearInterval(safetyPollTimer);
        safetyPollTimer = null;
      }
    },

    startPubSubListener(redis) {
      pubsubRedis = redis.duplicate();
      void pubsubRedis.psubscribe("ontology:*").catch((err) => {
        logger.error(`Failed to subscribe to ontology:*: ${String(err)}`);
      });
      pubsubRedis.on("pmessage", (_pattern: string, _channel: string, message: string) => {
        try {
          const data = JSON.parse(message) as { tenantId?: string };
          if (data.tenantId) {
            void this.refresh(data.tenantId);
          }
        } catch {
          logger.warn("Failed to parse ontology pub/sub message");
        }
      });
    },

    stopPubSubListener() {
      if (pubsubRedis) {
        void pubsubRedis.punsubscribe("ontology:*").catch(() => {});
        void pubsubRedis.quit().catch(() => {});
        pubsubRedis = null;
      }
    },
  };
}
