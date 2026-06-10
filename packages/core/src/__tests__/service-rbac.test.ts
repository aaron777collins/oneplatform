import { describe, it, expect } from "vitest";
import { isServiceCallAllowed } from "../service-rbac.js";

describe("isServiceCallAllowed", () => {
  // gateway-service is the catch-all entry point — it can call everything
  it("allows gateway-service to call any endpoint on any service", () => {
    expect(isServiceCallAllowed("gateway-service", "auth-service", "POST", "/api/v1/auth/login")).toBe(true);
    expect(isServiceCallAllowed("gateway-service", "execution-service", "POST", "/internal/execution/run")).toBe(true);
    expect(isServiceCallAllowed("gateway-service", "plugin-service", "GET", "/internal/plugins/widgets")).toBe(true);
  });

  // ingestion-service allowed paths
  it("allows ingestion-service to call POST /internal/ontology/map on ontology-service", () => {
    expect(isServiceCallAllowed("ingestion-service", "ontology-service", "POST", "/internal/ontology/map")).toBe(true);
  });

  it("allows ingestion-service to call POST /internal/ontology/infer on ontology-service", () => {
    expect(isServiceCallAllowed("ingestion-service", "ontology-service", "POST", "/internal/ontology/infer")).toBe(true);
  });

  it("allows ingestion-service to call POST /internal/pipeline/trigger on pipeline-service", () => {
    expect(isServiceCallAllowed("ingestion-service", "pipeline-service", "POST", "/internal/pipeline/trigger")).toBe(true);
  });

  it("allows ingestion-service to call POST /internal/execution/connector-run on execution-service", () => {
    expect(isServiceCallAllowed("ingestion-service", "execution-service", "POST", "/internal/execution/connector-run")).toBe(true);
  });

  it("allows ingestion-service to call GET /internal/plugins/connectors on plugin-service", () => {
    expect(isServiceCallAllowed("ingestion-service", "plugin-service", "GET", "/internal/plugins/connectors")).toBe(true);
  });

  // ingestion-service denied paths
  it("denies ingestion-service from calling auth-service endpoints", () => {
    expect(isServiceCallAllowed("ingestion-service", "auth-service", "GET", "/internal/auth/validate")).toBe(false);
  });

  it("denies ingestion-service from calling GET /internal/ontology/schema (not in its matrix)", () => {
    expect(isServiceCallAllowed("ingestion-service", "ontology-service", "GET", "/internal/ontology/schema")).toBe(false);
  });

  // ontology-service
  it("allows ontology-service to call POST /internal/execution/run on execution-service", () => {
    expect(isServiceCallAllowed("ontology-service", "execution-service", "POST", "/internal/execution/run")).toBe(true);
  });

  it("denies ontology-service from calling pipeline-service", () => {
    expect(isServiceCallAllowed("ontology-service", "pipeline-service", "POST", "/internal/pipeline/trigger")).toBe(false);
  });

  // pipeline-service
  it("allows pipeline-service to call POST /internal/execution/run", () => {
    expect(isServiceCallAllowed("pipeline-service", "execution-service", "POST", "/internal/execution/run")).toBe(true);
  });

  it("allows pipeline-service to call GET /internal/ontology/schema", () => {
    expect(isServiceCallAllowed("pipeline-service", "ontology-service", "GET", "/internal/ontology/schema")).toBe(true);
  });

  it("allows pipeline-service to call GET /internal/plugins/hooks", () => {
    expect(isServiceCallAllowed("pipeline-service", "plugin-service", "GET", "/internal/plugins/hooks")).toBe(true);
  });

  it("denies pipeline-service from calling auth-service", () => {
    expect(isServiceCallAllowed("pipeline-service", "auth-service", "GET", "/internal/auth/validate")).toBe(false);
  });

  // app-service
  it("allows app-service to call GET /internal/auth/validate on auth-service", () => {
    expect(isServiceCallAllowed("app-service", "auth-service", "GET", "/internal/auth/validate")).toBe(true);
  });

  it("allows app-service to call POST /internal/auth/guest-sessions on auth-service", () => {
    expect(isServiceCallAllowed("app-service", "auth-service", "POST", "/internal/auth/guest-sessions")).toBe(true);
  });

  it("allows app-service to call POST /internal/oauth/clients on auth-service", () => {
    expect(isServiceCallAllowed("app-service", "auth-service", "POST", "/internal/oauth/clients")).toBe(true);
  });

  it("allows app-service to call GET /internal/ontology/schema on ontology-service", () => {
    expect(isServiceCallAllowed("app-service", "ontology-service", "GET", "/internal/ontology/schema")).toBe(true);
  });

  it("allows app-service to call POST /internal/pipeline/trigger on pipeline-service", () => {
    expect(isServiceCallAllowed("app-service", "pipeline-service", "POST", "/internal/pipeline/trigger")).toBe(true);
  });

  it("allows app-service to call POST /internal/execution/run on execution-service", () => {
    expect(isServiceCallAllowed("app-service", "execution-service", "POST", "/internal/execution/run")).toBe(true);
  });

  it("allows app-service to call GET /internal/logging/query on logging-service", () => {
    expect(isServiceCallAllowed("app-service", "logging-service", "GET", "/internal/logging/query")).toBe(true);
  });

  it("allows app-service to call GET /internal/plugins/widgets on plugin-service", () => {
    expect(isServiceCallAllowed("app-service", "plugin-service", "GET", "/internal/plugins/widgets")).toBe(true);
  });

  // execution-service
  it("allows execution-service to call GET /internal/plugins/{id}/bundle on plugin-service", () => {
    expect(isServiceCallAllowed("execution-service", "plugin-service", "GET", "/internal/plugins/abc-123/bundle")).toBe(true);
  });

  it("denies execution-service from calling any auth-service endpoint", () => {
    expect(isServiceCallAllowed("execution-service", "auth-service", "GET", "/internal/auth/validate")).toBe(false);
  });

  // plugin-service
  it("allows plugin-service to call POST /internal/execution/run", () => {
    expect(isServiceCallAllowed("plugin-service", "execution-service", "POST", "/internal/execution/run")).toBe(true);
  });

  it("allows plugin-service to call POST /internal/execution/plugin-drain", () => {
    expect(isServiceCallAllowed("plugin-service", "execution-service", "POST", "/internal/execution/plugin-drain")).toBe(true);
  });

  it("allows plugin-service to call POST /internal/execution/plugin-cache-invalidate", () => {
    expect(isServiceCallAllowed("plugin-service", "execution-service", "POST", "/internal/execution/plugin-cache-invalidate")).toBe(true);
  });

  it("allows plugin-service to call POST /internal/ingestion/connectors", () => {
    expect(isServiceCallAllowed("plugin-service", "ingestion-service", "POST", "/internal/ingestion/connectors")).toBe(true);
  });

  it("allows plugin-service to call DELETE /internal/ingestion/connectors/instance/{id}", () => {
    expect(isServiceCallAllowed("plugin-service", "ingestion-service", "DELETE", "/internal/ingestion/connectors/instance/abc-123")).toBe(true);
  });

  it("allows plugin-service to call DELETE /internal/ingestion/connectors/plugin/{id}", () => {
    expect(isServiceCallAllowed("plugin-service", "ingestion-service", "DELETE", "/internal/ingestion/connectors/plugin/abc-123")).toBe(true);
  });

  it("denies plugin-service from calling auth-service", () => {
    expect(isServiceCallAllowed("plugin-service", "auth-service", "POST", "/internal/auth/guest-sessions")).toBe(false);
  });

  // auth-service and logging-service have no outbound calls
  it("denies auth-service from calling any other service", () => {
    expect(isServiceCallAllowed("auth-service", "ontology-service", "GET", "/internal/ontology/schema")).toBe(false);
  });

  it("denies logging-service from calling any other service", () => {
    expect(isServiceCallAllowed("logging-service", "pipeline-service", "POST", "/internal/pipeline/trigger")).toBe(false);
  });

  // Unknown callers are denied
  it("denies unknown caller service names", () => {
    expect(isServiceCallAllowed("rogue-service", "auth-service", "GET", "/internal/auth/validate")).toBe(false);
  });
});
