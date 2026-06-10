// Gateway-service-specific error classes extending @oneplatform/core's AppError.
// All codes are prefixed with GATEWAY_ per the error registry in L2 design §15.1.
// Standard codes (RATE_LIMIT_EXCEEDED, SERVICE_UNAVAILABLE, etc.) come from core.

import { AppError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Webhook errors
// ---------------------------------------------------------------------------

// Thrown when the webhook URL's resolved IP address falls within a private,
// loopback, or link-local range. Also raised on delivery when DNS rebinding
// is detected (the hostname now resolves to a blocked IP).
export class WebhookSsrfBlockedError extends AppError {
  readonly code = "GATEWAY_WEBHOOK_SSRF_BLOCKED" as const;
  readonly statusCode = 422;
}

// Thrown when the connectivity probe (POST to the webhook URL during
// registration) does not receive a 2xx response within 5 seconds.
export class WebhookConnectivityFailedError extends AppError {
  readonly code = "GATEWAY_WEBHOOK_CONNECTIVITY_FAILED" as const;
  readonly statusCode = 422;
}

// Thrown when the webhook URL is malformed, uses a disallowed protocol
// (http:// when OP_WEBHOOK_ALLOW_HTTP is not set), or the hostname
// is blocked before DNS resolution (localhost, *.local, *-service).
export class WebhookInvalidUrlError extends AppError {
  readonly code = "GATEWAY_WEBHOOK_INVALID_URL" as const;
  readonly statusCode = 422;
}

// ---------------------------------------------------------------------------
// SSE errors
// ---------------------------------------------------------------------------

// Thrown when a new SSE connection would exceed the per-API-key limit of 10
// concurrent connections. The 429 status maps to Retry-After in the response.
export class SseConnectionLimitError extends AppError {
  readonly code = "GATEWAY_SSE_CONNECTION_LIMIT" as const;
  readonly statusCode = 429;
}

// ---------------------------------------------------------------------------
// Routing errors
// ---------------------------------------------------------------------------

// Thrown when no registered route matches the request path. Distinct from
// the core NotFoundError so operators can differentiate routing misses from
// resource-not-found responses in logs.
export class RouteNotFoundError extends AppError {
  readonly code = "GATEWAY_ROUTE_NOT_FOUND" as const;
  readonly statusCode = 404;
}

// ---------------------------------------------------------------------------
// Proxy errors
// ---------------------------------------------------------------------------

// Thrown when an upstream service does not respond within its configured
// timeout window. The 503 prompts the client to retry with backoff.
export class ProxyTimeoutError extends AppError {
  readonly code = "GATEWAY_PROXY_TIMEOUT" as const;
  readonly statusCode = 503;
}

// Thrown when the circuit breaker for an upstream service is in the open
// state. The Gateway returns immediately without attempting the upstream
// call, preventing thread exhaustion against a down service.
export class ProxyUnavailableError extends AppError {
  readonly code = "GATEWAY_PROXY_UNAVAILABLE" as const;
  readonly statusCode = 503;
}

// ---------------------------------------------------------------------------
// Ontology cache errors
// ---------------------------------------------------------------------------

// Thrown when a request targets /api/v1/data/{entityType} and the entityType
// is not present in the tenant's ontology cache. The 404 is authoritative —
// the Gateway does not proxy unknown entity types to the Ontology Service.
export class EntityTypeNotFoundError extends AppError {
  readonly code = "GATEWAY_ENTITY_TYPE_NOT_FOUND" as const;
  readonly statusCode = 404;
}
