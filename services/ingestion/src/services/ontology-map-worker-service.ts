import type { Logger } from "@oneplatform/core";
import type { ServiceTokenSigner } from "@oneplatform/core";
import type { RawTableRepository } from "../repositories/raw-table-repository.js";

// The ontology service limits each map request to 100 records.
// Larger batches are split and dispatched sequentially so each sub-request
// stays within the schema constraint (mapRequest.records.max(100)).
const ONTOLOGY_MAP_CHUNK_SIZE = 100;

export interface OntologyMapJobPayload {
  connectorId: string;
  batchId: string;
  tenantId: string;
  // batchSeqNum is carried for logging context but not forwarded to the ontology
  // service — the endpoint does not use it.
  batchSeqNum: number;
}

export interface OntologyMapWorkerServiceDeps {
  rawTableRepo: RawTableRepository;
  ontologyServiceUrl: string;
  serviceTokenSigner: ServiceTokenSigner;
  logger: Logger;
}

// Transforms a raw DB row into the camelCase envelope shape expected by the
// ontology service's POST /internal/ontology/map endpoint (dataEnvelopeSchema).
function toOntologyEnvelope(row: {
  _id: string;
  _batch_id: string;
  _connector_id: string;
  _ingested_at: string;
  data: Record<string, unknown>;
}): {
  _id: string;
  _batchId: string;
  _connectorId: string;
  _ingestedAt: string;
  data: Record<string, unknown>;
} {
  return {
    _id: row._id,
    _batchId: row._batch_id,
    _connectorId: row._connector_id,
    _ingestedAt: row._ingested_at,
    data: row.data,
  };
}

export function createOntologyMapWorkerService(deps: OntologyMapWorkerServiceDeps) {
  const { rawTableRepo, ontologyServiceUrl, serviceTokenSigner, logger } = deps;

  // Processes a single "ontology.map" job:
  //   1. Fetch raw records for the batch from the connector's raw table.
  //   2. If no records exist (TTL/retention expiry or already processed), warn and complete.
  //   3. POST each 100-record chunk to the ontology service's map endpoint.
  //
  // Throws on HTTP errors so BullMQ retries the job according to the queue's
  // defaultJobOptions (5 attempts, exponential back-off).  Missing-batch is
  // treated as a terminal non-error so it does NOT trigger a retry.
  async function processOntologyMapJob(payload: OntologyMapJobPayload): Promise<void> {
    const { connectorId, batchId, tenantId, batchSeqNum } = payload;

    const rows = await rawTableRepo.fetchBatch(connectorId, batchId);

    if (rows.length === 0) {
      // Batch records may have been removed by the retention service or the
      // connector table may not yet exist (race on first-ever sync).  Either way
      // there is nothing to map — completing successfully prevents infinite retries.
      logger.warn("ontology-map-worker: batch records not found, skipping map", {
        connectorId,
        batchId,
        tenantId,
        batchSeqNum,
      });
      return;
    }

    const envelopes = rows.map(toOntologyEnvelope);

    // Chunk into groups of ONTOLOGY_MAP_CHUNK_SIZE to satisfy the ontology
    // service's per-request record limit.
    for (let offset = 0; offset < envelopes.length; offset += ONTOLOGY_MAP_CHUNK_SIZE) {
      const chunk = envelopes.slice(offset, offset + ONTOLOGY_MAP_CHUNK_SIZE);

      // Fresh token per chunk — the signer caches tokens for 5 minutes so this
      // is effectively free for all chunks within the same job execution.
      const token = await serviceTokenSigner.sign();

      const url = `${ontologyServiceUrl}/internal/ontology/map`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Service-Token": token,
        },
        body: JSON.stringify({ tenantId, connectorId, batchId, records: chunk }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "(unreadable)");
        throw new Error(
          `ontology-map-worker: ontology service returned ${response.status} for ` +
          `connectorId=${connectorId} batchId=${batchId} chunk=${offset / ONTOLOGY_MAP_CHUNK_SIZE}: ${body}`,
        );
      }

      logger.info("ontology-map-worker: chunk mapped successfully", {
        connectorId,
        batchId,
        tenantId,
        batchSeqNum,
        chunkStart: offset,
        chunkSize: chunk.length,
      });
    }
  }

  return { processOntologyMapJob };
}

export type OntologyMapWorkerService = ReturnType<typeof createOntologyMapWorkerService>;
