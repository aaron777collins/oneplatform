import type { Logger } from "@oneplatform/core";
import { ConnectorRegistrationFailedError } from "./errors.js";

// ---------------------------------------------------------------------------
// ConnectorRegistrationService
//
// Registers and deregisters connector instances with the Ingestion Service.
// Registration is required when enabling a connector-type plugin instance.
// Deregistration is best-effort (spec §9.2 — does not block disable on failure).
// ---------------------------------------------------------------------------

export interface ConnectorRegistrationConfig {
  ingestionServiceUrl: string;
  serviceToken: string;
  logger: Logger;
}

export interface ConnectorRegistrationPayload {
  pluginId: string;         // manifest_id
  instanceId: string;
  tenantId: string;
  displayName: string;
  version: string;
  metadata: Record<string, unknown>;
}

export interface ConnectorRegistrationService {
  register(payload: ConnectorRegistrationPayload): Promise<void>;
  deregisterInstance(instanceId: string): Promise<void>;
  deregisterPlugin(manifestId: string): Promise<void>;
}

export function createConnectorRegistrationService(
  config: ConnectorRegistrationConfig
): ConnectorRegistrationService {
  const { ingestionServiceUrl, serviceToken, logger } = config;

  function headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Service-Token": serviceToken,
    };
  }

  return {
    async register(payload: ConnectorRegistrationPayload): Promise<void> {
      const url = `${ingestionServiceUrl}/internal/ingestion/connectors`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        throw new ConnectorRegistrationFailedError(
          `Ingestion Service unreachable during connector registration: ${String(err)}`
        );
      }

      // 409 means already registered — treat as success (idempotent re-enable, spec §9.1).
      if (response.status === 409) {
        logger.info("Connector already registered with Ingestion Service (idempotent)", {
          instanceId: payload.instanceId,
        });
        return;
      }

      if (!response.ok) {
        throw new ConnectorRegistrationFailedError(
          `Ingestion Service returned ${response.status} during connector registration`,
          { instanceId: payload.instanceId, status: response.status }
        );
      }
    },

    async deregisterInstance(instanceId: string): Promise<void> {
      const url = `${ingestionServiceUrl}/internal/ingestion/connectors/instance/${encodeURIComponent(instanceId)}`;

      try {
        const response = await fetch(url, {
          method: "DELETE",
          headers: headers(),
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok && response.status !== 404) {
          // Deregistration is best-effort (spec §9.2).
          logger.error(
            "Ingestion Service deregistration failed (best-effort — proceeding)",
            { instanceId, status: response.status }
          );
        }
      } catch (err) {
        logger.error(
          "Ingestion Service unreachable during connector deregistration (best-effort — proceeding)",
          { instanceId, error: String(err) }
        );
      }
    },

    async deregisterPlugin(manifestId: string): Promise<void> {
      const url = `${ingestionServiceUrl}/internal/ingestion/connectors/plugin/${encodeURIComponent(manifestId)}`;

      try {
        const response = await fetch(url, {
          method: "DELETE",
          headers: headers(),
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok && response.status !== 404) {
          logger.error(
            "Ingestion Service plugin deregistration failed (best-effort — proceeding with uninstall)",
            { manifestId, status: response.status }
          );
        }
      } catch (err) {
        logger.error(
          "Ingestion Service unreachable during plugin deregistration (best-effort — proceeding)",
          { manifestId, error: String(err) }
        );
      }
    },
  };
}
