# Example: Webhook Event Processing

This example demonstrates how to receive, verify, route, and process webhook
events from external systems using OnePlatform. It covers:

1. Configuring a webhook receiver with HMAC signature verification
2. Defining event-driven pipeline routing by event type
3. Subscribing to real-time platform events via the SDK
4. Sending test events with curl to validate the integration

## Use Case

You operate an e-commerce platform that generates events across multiple
subsystems -- order management, user accounts, payments, inventory, and
monitoring. Each subsystem sends webhooks to OnePlatform, which verifies
signatures, routes events to the correct pipeline, and processes them in
real time. This pattern replaces ad-hoc webhook handlers scattered across
services with a single, observable ingestion layer.

## Prerequisites

- Node.js 18+
- A running OnePlatform instance (local or hosted)
- An API key with `events:read`, `pipelines:write`, and `connectors:write` scopes
- `curl` (for sending test events)

## Project Structure

```
webhook-event-processing/
  configs/
    webhook-receiver.json    -- Webhook receiver with signature verification
    event-pipeline.json      -- Event-driven pipeline definition
  src/
    setup.ts                 -- SDK setup: registers receiver and pipeline
    event-handler.ts         -- Real-time event handler with routing
  test/
    send-events.sh           -- Sends all sample events via curl
    sample-events/
      order-created.json     -- E-commerce order placed
      user-signup.json       -- New user registration
      payment-completed.json -- Payment processed successfully
      inventory-update.json  -- Stock level changed
      alert-triggered.json   -- Monitoring alert fired
  package.json
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set your credentials
export OP_BASE_URL=https://your-instance.example.com
export OP_API_KEY=op_live_...
export OP_WEBHOOK_SECRET=whsec_your_signing_secret_here

# 3. Register the webhook receiver and pipeline
npm run setup

# 4. Start the event handler (listens for real-time events)
npm run handler

# 5. In a separate terminal, send test events
npm run test:events
```

## How It Works

### Webhook Receiver

The `configs/webhook-receiver.json` file defines a receiver endpoint at
`/webhooks/external-events`. Every incoming request is validated against an
HMAC-SHA256 signature sent in the `X-Webhook-Signature` header. Requests
with missing or invalid signatures are rejected with a 401 response.

The receiver supports five event types, each routed to the event pipeline
with a priority level:

| Event Type           | Priority   | Description                    |
|----------------------|------------|--------------------------------|
| `order.created`      | high       | New e-commerce order placed    |
| `user.signup`        | normal     | User account registered        |
| `payment.completed`  | high       | Payment successfully processed |
| `inventory.update`   | low        | Stock level changed            |
| `alert.triggered`    | critical   | Monitoring alert fired         |

### Event Pipeline

The pipeline in `configs/event-pipeline.json` processes incoming events
through four steps:

1. **validate** -- Checks the event payload against a JSON schema for the
   declared event type. Malformed events are routed to a dead-letter queue.
2. **enrich** -- Looks up related entities (customer, product, etc.) from
   the platform data store and attaches them to the event context.
3. **transform** -- Normalizes the event into a canonical format suitable
   for downstream consumers (analytics, notifications, audit log).
4. **dispatch** -- Writes the processed event to the appropriate entity
   store and optionally triggers follow-up actions (email, Slack, PagerDuty).

### Event Handler

The `src/event-handler.ts` script uses the SDK's `client.events.subscribe()`
method to receive events in real time via Server-Sent Events (SSE). It
demonstrates:

- Subscribing to multiple event patterns with wildcard matching
- Routing events to type-specific handler functions
- Logging event metadata for observability
- Graceful shutdown on SIGINT/SIGTERM

## Signature Verification

OnePlatform verifies webhook signatures using the algorithm and encoding
specified in the receiver config:

```
HMAC-SHA256(
  timestamp + "." + raw_request_body,
  webhook_secret
)
```

The result is compared to the value in the `X-Webhook-Signature` header
after stripping the `sha256=` prefix. A timestamp tolerance of 300 seconds
prevents replay attacks.

## Sending Test Events

The `test/send-events.sh` script sends all five sample events to your local
OnePlatform instance. Each request includes the correct HMAC signature
computed from the `OP_WEBHOOK_SECRET` environment variable.

To send a single event manually:

```bash
BODY=$(cat test/sample-events/order-created.json)
TIMESTAMP=$(date +%s)
SIGNATURE=$(echo -n "${TIMESTAMP}.${BODY}" | \
  openssl dgst -sha256 -hmac "${OP_WEBHOOK_SECRET}" | awk '{print $2}')

curl -X POST "${OP_BASE_URL}/webhooks/external-events" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: sha256=${SIGNATURE}" \
  -H "X-Webhook-Timestamp: ${TIMESTAMP}" \
  -d "${BODY}"
```

## Cleaning Up

Delete the webhook receiver and pipeline from the platform UI under
**Settings > Webhooks** and **Settings > Pipelines**, or use the SDK:

```typescript
await client.connectors.delete(receiverId);
await client.pipelines.delete(pipelineId);
```

## What's Next

- **[Multi-Source ETL](../multi-source-etl/)** -- Merge data from PostgreSQL
  and MySQL into unified entities with scheduled pipelines
- **[Data Pipeline](../data-pipeline/)** -- Build a product catalog ingestion
  pipeline with REST API connectors
- **[Quick Start](../quick-start/)** -- End-to-end walkthrough from connector
  to deployed application
