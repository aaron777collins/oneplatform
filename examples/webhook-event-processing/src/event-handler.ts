/**
 * Webhook Event Handler
 *
 * Demonstrates how to build a local event handler that processes webhook events
 * from OnePlatform's real-time event stream. This script:
 *
 *   1. Connects to the platform's SSE event stream
 *   2. Validates incoming event payloads
 *   3. Routes events to type-specific handlers
 *   4. Implements retry logic with exponential backoff for transient failures
 *   5. Logs processing results for observability
 *
 * In production, this logic would typically run inside a pipeline step (as shown
 * in configs/event-pipeline.json). This standalone handler is useful for:
 *   - Local development and debugging
 *   - Custom processing that extends the pipeline
 *   - Sidecar processes that react to platform events
 *
 * Run with: npm run handler
 *
 * Required environment variables:
 *   OP_BASE_URL  — e.g. https://your-instance.example.com
 *   OP_API_KEY   — API key with events:read scope
 */

import { createClient } from "@oneplatform/sdk";
import type { PlatformEvent } from "@oneplatform/sdk";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = process.env["OP_BASE_URL"];
const API_KEY = process.env["OP_API_KEY"];

if (!BASE_URL || !API_KEY) {
  console.error(
    "Error: OP_BASE_URL and OP_API_KEY environment variables are required.\n" +
      "  export OP_BASE_URL=https://your-instance.example.com\n" +
      "  export OP_API_KEY=op_live_...",
  );
  process.exit(1);
}

const client = createClient({
  baseUrl: BASE_URL,
  auth: { apiKey: API_KEY },
});

// ---------------------------------------------------------------------------
// Types — event payload shapes for each supported event type
// ---------------------------------------------------------------------------

interface OrderCreatedPayload {
  order_id: string;
  customer_email: string;
  items: Array<{ sku: string; name: string; quantity: number; price: number }>;
  total: number;
  currency: string;
  shipping_address: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
}

interface UserSignupPayload {
  user_id: string;
  email: string;
  name: string;
  plan: string;
  source: string;
}

interface PaymentCompletedPayload {
  payment_id: string;
  order_id: string;
  amount: number;
  currency: string;
  payment_method: string;
  status: string;
  processor_response: {
    transaction_id: string;
    authorization_code: string;
  };
}

interface InventoryUpdatePayload {
  sku: string;
  warehouse_id: string;
  product_name: string;
  quantity_change: number;
  new_quantity: number;
  reason: string;
}

interface AlertTriggeredPayload {
  alert_id: string;
  severity: "critical" | "warning" | "info";
  service: string;
  message: string;
  metric_name: string;
  metric_value: number;
  threshold: number;
}

/** The standard envelope every webhook event uses. */
interface WebhookEventEnvelope {
  event_id: string;
  event_type: string;
  timestamp: string;
  source: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validation — check required fields before processing
// ---------------------------------------------------------------------------

/** Fields every webhook event envelope must contain. */
const REQUIRED_ENVELOPE_FIELDS: readonly string[] = [
  "event_id",
  "event_type",
  "timestamp",
  "data",
];

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateEventEnvelope(payload: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof payload !== "object" || payload === null) {
    return { valid: false, errors: ["Payload must be a non-null object"] };
  }

  const record = payload as Record<string, unknown>;

  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    if (record[field] === undefined || record[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (typeof record["event_type"] === "string") {
    // Event types must be dot-separated identifiers (e.g. "order.created").
    const typePattern = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
    if (!typePattern.test(record["event_type"])) {
      errors.push(
        `Invalid event_type format: "${record["event_type"]}". ` +
          "Expected dot-separated lowercase identifiers (e.g. order.created).",
      );
    }
  }

  if (typeof record["timestamp"] === "string") {
    const date = new Date(record["timestamp"]);
    if (isNaN(date.getTime())) {
      errors.push(`Invalid timestamp: "${record["timestamp"]}". Expected ISO 8601 format.`);
    }
  }

  if (record["data"] !== undefined && (typeof record["data"] !== "object" || record["data"] === null)) {
    errors.push("data field must be a non-null object");
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Retry logic — exponential backoff with jitter for transient failures
// ---------------------------------------------------------------------------

interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Multiplier applied to delay after each attempt. Default: 2. */
  backoffFactor: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffFactor: 2,
};

/**
 * Executes an async function with exponential backoff retry.
 *
 * The delay between attempts grows exponentially (1s, 2s, 4s, 8s, ...) with
 * random jitter (0-500ms) added to prevent thundering herd when multiple
 * handlers retry simultaneously.
 *
 * Only retries on errors that are considered transient (network timeouts,
 * 5xx responses). Permanent errors (validation failures, 4xx responses) are
 * thrown immediately without retry.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const config = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;

      // Don't retry permanent failures.
      if (isPermanentError(error)) {
        console.error(
          `  [${operationName}] Permanent error on attempt ${attempt}: ${error.message}`,
        );
        throw error;
      }

      if (attempt === config.maxAttempts) {
        console.error(
          `  [${operationName}] All ${config.maxAttempts} attempts exhausted. Last error: ${error.message}`,
        );
        break;
      }

      // Calculate delay: base * factor^(attempt-1) + random jitter.
      const baseDelay = config.initialDelayMs * Math.pow(config.backoffFactor, attempt - 1);
      const jitter = Math.random() * 500;
      const delay = Math.min(baseDelay + jitter, config.maxDelayMs);

      console.warn(
        `  [${operationName}] Attempt ${attempt}/${config.maxAttempts} failed: ${error.message}. ` +
          `Retrying in ${Math.round(delay)}ms...`,
      );

      await sleep(delay);
    }
  }

  throw lastError ?? new Error(`${operationName} failed after ${config.maxAttempts} attempts`);
}

/** Returns true for errors that should not be retried. */
function isPermanentError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("validation") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("not found") ||
    message.includes("400") ||
    message.includes("401") ||
    message.includes("403") ||
    message.includes("404") ||
    message.includes("422")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Event handlers — one per event type
//
// Each handler receives a typed payload and returns a processing result.
// In a real application these would call external APIs, update databases,
// send notifications, etc.
// ---------------------------------------------------------------------------

interface ProcessingResult {
  success: boolean;
  entityType: string;
  entityId: string;
  action: string;
  details?: Record<string, unknown>;
}

async function handleOrderCreated(data: OrderCreatedPayload): Promise<ProcessingResult> {
  // In production: create the order in your OMS, send confirmation email, etc.
  console.log(`    Processing order ${data.order_id} for ${data.customer_email}`);
  console.log(`    Items: ${data.items.length}, Total: ${data.currency} ${data.total}`);

  return {
    success: true,
    entityType: "Order",
    entityId: data.order_id,
    action: "created",
    details: {
      customerEmail: data.customer_email,
      itemCount: data.items.length,
      total: data.total,
      currency: data.currency,
    },
  };
}

async function handleUserSignup(data: UserSignupPayload): Promise<ProcessingResult> {
  // In production: provision user account, send welcome email, update CRM.
  console.log(`    New user signup: ${data.email} (plan: ${data.plan})`);
  console.log(`    Source: ${data.source}`);

  return {
    success: true,
    entityType: "User",
    entityId: data.user_id,
    action: "signup",
    details: {
      email: data.email,
      plan: data.plan,
      source: data.source,
    },
  };
}

async function handlePaymentCompleted(data: PaymentCompletedPayload): Promise<ProcessingResult> {
  // In production: reconcile payment, update order status, trigger fulfillment.
  console.log(`    Payment ${data.payment_id} completed for order ${data.order_id}`);
  console.log(`    Amount: ${data.currency} ${data.amount} via ${data.payment_method}`);

  return {
    success: true,
    entityType: "Payment",
    entityId: data.payment_id,
    action: "completed",
    details: {
      orderId: data.order_id,
      amount: data.amount,
      method: data.payment_method,
      transactionId: data.processor_response.transaction_id,
    },
  };
}

async function handleInventoryUpdate(data: InventoryUpdatePayload): Promise<ProcessingResult> {
  // In production: update stock levels, trigger reorder if below threshold.
  const direction = data.quantity_change > 0 ? "increased" : "decreased";
  console.log(
    `    Inventory ${direction} for ${data.product_name} (${data.sku})`,
  );
  console.log(
    `    Change: ${data.quantity_change}, New quantity: ${data.new_quantity} at warehouse ${data.warehouse_id}`,
  );

  return {
    success: true,
    entityType: "InventoryItem",
    entityId: data.sku,
    action: "updated",
    details: {
      warehouseId: data.warehouse_id,
      quantityChange: data.quantity_change,
      newQuantity: data.new_quantity,
      reason: data.reason,
    },
  };
}

async function handleAlertTriggered(data: AlertTriggeredPayload): Promise<ProcessingResult> {
  // In production: page on-call, create incident ticket, update status page.
  const severityEmoji =
    data.severity === "critical" ? "[CRITICAL]" :
    data.severity === "warning" ? "[WARNING]" : "[INFO]";

  console.log(`    ${severityEmoji} Alert from ${data.service}: ${data.message}`);
  console.log(
    `    Metric: ${data.metric_name} = ${data.metric_value} (threshold: ${data.threshold})`,
  );

  return {
    success: true,
    entityType: "Alert",
    entityId: data.alert_id,
    action: "triggered",
    details: {
      severity: data.severity,
      service: data.service,
      metricName: data.metric_name,
      metricValue: data.metric_value,
      threshold: data.threshold,
    },
  };
}

// ---------------------------------------------------------------------------
// Event router — dispatches events to the correct handler based on type
// ---------------------------------------------------------------------------

/** Map of event type strings to their handler functions. */
const EVENT_HANDLERS: Record<
  string,
  (data: Record<string, unknown>) => Promise<ProcessingResult>
> = {
  "order.created": (data) => handleOrderCreated(data as unknown as OrderCreatedPayload),
  "user.signup": (data) => handleUserSignup(data as unknown as UserSignupPayload),
  "payment.completed": (data) => handlePaymentCompleted(data as unknown as PaymentCompletedPayload),
  "inventory.update": (data) => handleInventoryUpdate(data as unknown as InventoryUpdatePayload),
  "alert.triggered": (data) => handleAlertTriggered(data as unknown as AlertTriggeredPayload),
};

async function routeEvent(envelope: WebhookEventEnvelope): Promise<ProcessingResult> {
  const handler = EVENT_HANDLERS[envelope.event_type];

  if (handler === undefined) {
    console.warn(`  No handler registered for event type: ${envelope.event_type}`);
    return {
      success: false,
      entityType: "Unknown",
      entityId: envelope.event_id,
      action: "skipped",
      details: { reason: `Unhandled event type: ${envelope.event_type}` },
    };
  }

  // Wrap the handler call in retry logic for transient failures.
  return withRetry(
    () => handler(envelope.data),
    `handle:${envelope.event_type}:${envelope.event_id}`,
    { maxAttempts: 3, initialDelayMs: 500 },
  );
}

// ---------------------------------------------------------------------------
// Processing statistics — track success/failure counts for observability
// ---------------------------------------------------------------------------

interface ProcessingStats {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  byType: Record<string, { succeeded: number; failed: number }>;
  startedAt: Date;
}

const stats: ProcessingStats = {
  total: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  byType: {},
  startedAt: new Date(),
};

function updateStats(eventType: string, result: ProcessingResult): void {
  stats.total++;

  if (result.action === "skipped") {
    stats.skipped++;
    return;
  }

  if (!stats.byType[eventType]) {
    stats.byType[eventType] = { succeeded: 0, failed: 0 };
  }

  if (result.success) {
    stats.succeeded++;
    stats.byType[eventType]!.succeeded++;
  } else {
    stats.failed++;
    stats.byType[eventType]!.failed++;
  }
}

function printStats(): void {
  const elapsed = (Date.now() - stats.startedAt.getTime()) / 1_000;
  console.log("\n--- Processing Statistics ---");
  console.log(`  Uptime:    ${elapsed.toFixed(1)}s`);
  console.log(`  Total:     ${stats.total}`);
  console.log(`  Succeeded: ${stats.succeeded}`);
  console.log(`  Failed:    ${stats.failed}`);
  console.log(`  Skipped:   ${stats.skipped}`);

  if (Object.keys(stats.byType).length > 0) {
    console.log("  By type:");
    for (const [type, counts] of Object.entries(stats.byType)) {
      console.log(`    ${type}: ${counts.succeeded} ok, ${counts.failed} failed`);
    }
  }
  console.log("---\n");
}

// ---------------------------------------------------------------------------
// Main event processing loop
// ---------------------------------------------------------------------------

async function processEvent(platformEvent: PlatformEvent): Promise<void> {
  // The platform event payload contains the original webhook event envelope.
  const envelope = platformEvent.payload as unknown as WebhookEventEnvelope;

  console.log(
    `\n  [${new Date().toISOString()}] Received: ${envelope.event_type} (${envelope.event_id})`,
  );

  // Step 1: Validate the event envelope.
  const validation = validateEventEnvelope(envelope);
  if (!validation.valid) {
    console.error(`  Validation failed for ${envelope.event_id}:`);
    for (const error of validation.errors) {
      console.error(`    - ${error}`);
    }
    stats.total++;
    stats.failed++;
    return;
  }

  // Step 2: Route to the appropriate handler with retry logic.
  try {
    const result = await routeEvent(envelope);
    updateStats(envelope.event_type, result);

    if (result.success) {
      console.log(
        `  Processed: ${result.entityType}/${result.entityId} (${result.action})`,
      );
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`  Processing failed for ${envelope.event_id}: ${error.message}`);
    stats.total++;
    stats.failed++;
  }
}

async function main(): Promise<void> {
  // Verify credentials.
  console.log("Verifying connection...");
  const identity = await client.ping();
  console.log(
    `  Connected as ${identity.email} (tenant: ${identity.tenantId})\n`,
  );

  console.log("Starting webhook event handler...");
  console.log("Subscribing to webhook.event.* events...\n");

  // Subscribe to all webhook events using a wildcard pattern.
  const subscription = client.events.subscribe(
    {
      events: [
        "webhook.event.received",
        "pipeline.run.completed",
        "pipeline.run.failed",
      ],
    },
    (event) => {
      // Fire-and-forget the async handler — errors are caught internally.
      processEvent(event).catch((err) => {
        console.error("Unhandled error in event processing:", err);
      });
    },
  );

  subscription.onStatus((status) => {
    console.log(`Event stream status: ${status}`);
  });

  subscription.onError((error) => {
    console.error(`Event stream error: ${error.message}`);
  });

  // Print stats every 30 seconds.
  const statsInterval = setInterval(printStats, 30_000);

  // Graceful shutdown on SIGINT/SIGTERM.
  const shutdown = (): void => {
    console.log("\nShutting down event handler...");
    clearInterval(statsInterval);
    printStats();
    subscription.unsubscribe();
    client.destroy();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("Event handler is running. Press Ctrl+C to stop.\n");
}

main().catch((err: unknown) => {
  console.error("Event handler failed to start:", err instanceof Error ? err.message : err);
  client.destroy();
  process.exit(1);
});
