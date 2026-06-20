# Example: Webhook Event Processing

This example demonstrates how to receive, verify, route, and process webhook events
from external systems using `@oneplatform/sdk`. It covers the full lifecycle from
setting up a secure webhook endpoint to processing events through a multi-step
pipeline.

## What you will learn

- **Webhook setup** -- Register a webhook receiver endpoint with OnePlatform
- **Signature verification** -- Secure inbound events with HMAC-SHA256 signatures
- **Event routing** -- Route different event types to specialized processing logic
- **Pipeline triggers** -- Automatically trigger data pipelines from webhook events
- **Error handling** -- Validate payloads, handle failures, and retry transient errors
- **Real-time monitoring** -- Subscribe to platform events to observe processing results

## Use case

You operate an e-commerce platform that generates events across multiple
subsystems -- order management, user accounts, payments, inventory, and
monitoring. Each subsystem sends webhooks to OnePlatform, which verifies
signatures, routes events to the correct pipeline, and processes them in
real time. This pattern replaces ad-hoc webhook handlers scattered across
services with a single, observable ingestion layer.

## Prerequisites

- Node.js 18 or later
- A running OnePlatform instance (local or hosted)
- An API key with `connectors:write`, `ontologies:write`, `pipelines:write`, and `events:read` scopes
- `openssl` (included on macOS and most Linux distributions) for sending test events
- `curl` for sending test events from the shell

## Project structure

```
webhook-event-processing/
  configs/
    webhook-receiver.json    -- Webhook receiver configuration reference
    event-pipeline.json      -- Pipeline definition triggered by webhook events
  src/
    setup.ts                 -- Creates all platform resources (receiver, ontology, pipeline)
    event-handler.ts         -- Standalone event handler with routing and retry logic
  test/
    send-events.sh           -- Shell script to send sample events via curl
    sample-events/           -- 5 realistic webhook payload files
      alert.triggered.json
      inventory.update.json
      order.created.json
      payment.completed.json
      user.signup.json
  package.json
  README.md                  -- This file
```

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Set your credentials
export OP_BASE_URL=https://your-instance.example.com
export OP_API_KEY=op_live_...
export WEBHOOK_SECRET=whsec_your_shared_secret

# 3. Run the setup script (creates receiver, ontology, and pipeline)
npm run setup

# 4. Send sample webhook events
npm run test:events

# 5. Start the event handler (optional -- for local processing)
npm run handler
```

## Step-by-step walkthrough

### 1. Setting up the webhook receiver

The setup script (`src/setup.ts`) creates three platform resources:

| Resource | Name | Purpose |
|---|---|---|
| Connector | External Events Receiver | HTTP endpoint that accepts inbound webhook POSTs |
| Ontology entity | WebhookEvent | Schema for storing processed events in the data store |
| Pipeline | Webhook Event Pipeline | Multi-step workflow triggered by each accepted event |

After setup completes, your webhook endpoint is live at:

```
POST {OP_BASE_URL}/api/v1/webhooks/external-events
```

### 2. How signature verification works

OnePlatform verifies every inbound webhook request using HMAC-SHA256 to ensure the
payload has not been tampered with and originates from a trusted source.

**How the sending system signs a request:**

1. Serialize the request body as a byte string (the exact bytes that will be sent)
2. Compute `HMAC-SHA256(body_bytes, shared_secret)` using the shared secret
3. Hex-encode the result and prefix it with `sha256=`
4. Include the signature in the `X-Webhook-Signature` header

**How OnePlatform verifies the signature:**

1. Read the raw request body as bytes (before any JSON parsing)
2. Retrieve the encrypted signing secret from the credential vault
3. Compute the expected HMAC-SHA256 digest using the stored secret
4. Compare the expected digest with the incoming signature using constant-time
   comparison (`timingSafeEqual`) to prevent timing attacks
5. Accept the event only if the signatures match; otherwise silently drop it

**Example -- computing the signature with openssl:**

```bash
# The shared secret (same value configured in the receiver)
SECRET="whsec_your_shared_secret"

# The request body
BODY='{"event_id":"evt_001","event_type":"order.created","timestamp":"2024-09-15T14:32:07Z","data":{}}'

# Compute the signature
SIGNATURE="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')"

# Send the request
curl -X POST https://your-instance.example.com/api/v1/webhooks/external-events \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: $SIGNATURE" \
  -d "$BODY"
```

**Security notes:**

- The raw secret is never stored on the platform. Only a cryptographic hash
  (encrypted with AES-256-GCM) is persisted.
- The receiver always returns HTTP 200 regardless of whether verification succeeds
  or fails. This prevents attackers from using response codes to enumerate valid
  receiver IDs or probe signature validity.
- The signature header name (`X-Webhook-Signature`) and algorithm (`sha256`/`sha512`)
  are configurable per receiver to match your event source's conventions.

### 3. Event routing and pipeline triggers

When a webhook event passes signature verification, the platform:

1. **Parses** the JSON body and wraps it in a `DataEnvelope`
2. **Stores** the raw event in the connector's staging table
3. **Enqueues** a pipeline run with the event payload as input

The pipeline (defined in `configs/event-pipeline.json`) processes each event through
these steps:

```
receive --> validate --> enrich --> branch (by event type)
                                      |
                      +------+--------+--------+--------+
                      |      |        |        |        |
                   order  payment   user   inventory  alert
                      |      |        |        |        |
                      +------+--------+--------+--------+
                                      |
                                   store --> notify
```

**Step details:**

| Step | Type | Description |
|---|---|---|
| receive | webhook | Extracts the raw payload and metadata from the pipeline input |
| validate | code | Checks that required fields (`event_id`, `event_type`, `timestamp`, `data`) are present |
| enrich | code | Adds processing metadata: timestamp, correlation ID, normalized type |
| branch | conditional | Routes to a type-specific code step based on `event_type` |
| store | connector | Writes the processed event to the `WebhookEvent` entity store (upsert) |
| notify | code | Emits a platform event for downstream subscribers |

### 4. Supported event types

This example includes handlers and sample payloads for five common event types:

| Event Type | Priority | Source System | What It Represents |
|---|---|---|---|
| `order.created` | high | E-commerce platform | A new customer order with line items, totals, and shipping |
| `user.signup` | normal | Authentication service | A new user registration with plan and referral details |
| `payment.completed` | high | Payment gateway | A successful payment with processor response details |
| `inventory.update` | low | Warehouse management | Stock level change for a product at a specific warehouse |
| `alert.triggered` | critical | Monitoring service | An infrastructure alert with metric values and thresholds |

### 5. Event payload format

Every webhook event must follow this envelope structure:

```json
{
  "event_id": "evt_unique_identifier",
  "event_type": "resource.action",
  "timestamp": "2024-09-15T14:32:07.891Z",
  "source": "sending-system-name",
  "data": {
    // Event-specific payload -- any valid JSON object
  }
}
```

**Required fields:**

| Field | Type | Description |
|---|---|---|
| `event_id` | string | Unique identifier for this event. Used for deduplication. |
| `event_type` | string | Dot-separated type (e.g. `order.created`). Must be lowercase. |
| `timestamp` | string | ISO 8601 timestamp when the event occurred at the source. |
| `data` | object | Event-specific payload. Structure varies by event type. |

**Optional fields:**

| Field | Type | Description |
|---|---|---|
| `source` | string | Identifier of the system that generated the event. |

### 6. Error handling and retry logic

The event handler (`src/event-handler.ts`) demonstrates production-grade error handling:

**Validation:**
- Every event is validated against the envelope schema before processing
- Invalid events are logged and counted but do not crash the handler
- Event type format is checked against the `resource.action` pattern

**Retry with exponential backoff:**
- Transient failures (network timeouts, 5xx errors) are retried automatically
- Delay grows exponentially: 500ms, 1s, 2s (configurable via `RetryOptions`)
- Random jitter (0-500ms) prevents thundering herd on concurrent retries
- Permanent errors (validation failures, 4xx responses) fail immediately without retry

**Graceful shutdown:**
- SIGINT and SIGTERM handlers clean up SSE subscriptions and print final statistics
- In-flight event processing completes before the process exits

### 7. Sending test events

The `test/send-events.sh` script sends all sample events or specific ones:

```bash
# Send all 5 sample events
npm run test:events

# Send a specific event
bash test/send-events.sh test/sample-events/order.created.json

# Send multiple specific events
bash test/send-events.sh test/sample-events/order.created.json test/sample-events/payment.completed.json
```

The script automatically:
- Computes the HMAC-SHA256 signature for each payload using your `WEBHOOK_SECRET`
- Includes the signature in the `X-Webhook-Signature` header
- Reports HTTP status codes for each request
- Adds a 500ms delay between events to avoid overwhelming the receiver

### 8. Running the standalone event handler

The event handler (`src/event-handler.ts`) connects to the platform's SSE event
stream and processes webhook events locally. This is useful for development,
debugging, or running custom processing logic alongside the pipeline:

```bash
npm run handler
```

The handler:
- Subscribes to `webhook.event.received`, `pipeline.run.completed`, and `pipeline.run.failed` events
- Validates each event envelope
- Routes events to type-specific handler functions
- Retries transient failures with exponential backoff
- Prints processing statistics every 30 seconds
- Shuts down gracefully on Ctrl+C

## Configuration reference

### Webhook receiver (`configs/webhook-receiver.json`)

The receiver config defines the HTTP endpoint, authentication, and routing:

| Field | Type | Default | Description |
|---|---|---|---|
| `receiver.pathSuffix` | string | (required) | URL path segment: `/api/v1/webhooks/{pathSuffix}` |
| `receiver.hmacAlgorithm` | `sha256` or `sha512` | `sha256` | HMAC algorithm for signature verification |
| `receiver.headerName` | string | `X-Webhook-Signature` | HTTP header containing the signature |
| `receiver.isEnabled` | boolean | `true` | Whether the endpoint accepts events |
| `signature.timestampTolerance` | number | `300` | Max age (seconds) of the timestamp header |
| `delivery.retryPolicy.maxAttempts` | number | `5` | How many times to retry failed deliveries |
| `routing.defaultPipeline` | string | (none) | Pipeline to trigger for unrouted event types |

### Event pipeline (`configs/event-pipeline.json`)

The pipeline config defines the processing workflow. See the `PipelineDefinition`
type in `@oneplatform/sdk` for the full schema.

Key options:

| Field | Default | Description |
|---|---|---|
| `options.allowConcurrentRuns` | `true` | Process multiple events simultaneously |
| `options.maxConcurrentRuns` | `10` | Maximum parallel pipeline runs |
| `options.stepTimeout` | `30000` | Per-step timeout in milliseconds |
| `options.retainRunsCount` | `500` | Number of completed runs to keep for audit |

## Integrating with your own systems

To receive webhooks from a real external system:

1. **Create the receiver** using `npm run setup` (or the SDK directly)
2. **Copy the webhook URL** printed by the setup script
3. **Configure your external system** to POST events to that URL, using:
   - The `WEBHOOK_SECRET` as the signing secret
   - HMAC-SHA256 as the signature algorithm
   - `X-Webhook-Signature` as the signature header (or configure a different header name)
4. **Add event type handlers** in `src/event-handler.ts` for your specific event types
5. **Update the pipeline** steps in `src/setup.ts` to match your processing logic

## Cleaning up

Delete the resources from the platform UI:

- **Connector:** Settings -> Data Sources -> External Events Receiver -> Delete
- **Ontology:** Settings -> Ontology -> WebhookEvent -> Delete
- **Pipeline:** Settings -> Pipelines -> Webhook Event Pipeline -> Delete

Or programmatically via the SDK:

```typescript
import { createClient } from '@oneplatform/sdk';

const client = createClient({
  baseUrl: process.env['OP_BASE_URL']!,
  auth: { apiKey: process.env['OP_API_KEY']! },
});

await client.connectors.delete('<receiver-id>');
await client.ontologies.delete('<ontology-id>');
await client.pipelines.delete('webhook-event-pipeline');

client.destroy();
```

## Related examples and documentation

- **[Data Pipeline Example](../data-pipeline/)** -- Simpler pipeline setup with REST API connectors
- **[Custom Connector Example](../custom-connector/)** -- Building custom data source connectors
- **[Ingestion Service Design](../../docs/designs/ingestion-service-design.md)** -- Webhook receiver internals
- **[Pipeline Service Design](../../docs/designs/pipeline-service-design.md)** -- Pipeline step types and configuration
- **[SDK Reference](../../packages/sdk/README.md)** -- Full SDK API documentation
