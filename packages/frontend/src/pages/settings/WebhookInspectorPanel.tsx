/**
 * WebhookInspectorPanel — slide-over panel showing the delivery history
 * for a single webhook receiver.
 *
 * Opened by clicking the "Inspect" button in the webhook table row.
 * Selecting a delivery in the list expands the full detail view: headers,
 * body (syntax-highlighted JSON), and timing metadata.
 *
 * Design decisions:
 * - Uses Dialog (already a project dependency) as a wide modal rather than
 *   a Sheet primitive, which is not in the current dependency set.
 * - Body rendering uses a <pre> block with Tailwind typography for
 *   lightweight JSON highlighting — Monaco is not loaded here because
 *   delivery bodies are read-only and the editor initialization cost is
 *   not justified for this view.
 * - The delivery list query is kept separate from the detail query so
 *   navigating between deliveries does not re-fetch the list.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Clock, ChevronLeft, AlertCircle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog.js";
import { Badge } from "@/components/ui/badge.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { useApiClient, type PaginatedResponse, type ApiResponse } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// API types — mirror the backend DeliveryLogEntry / DeliveryLogDetail shapes
// ---------------------------------------------------------------------------

interface DeliveryEntry {
  id: string;
  webhookId: string;
  receivedAt: string;
  signatureValid: boolean | null;
  statusCode: number;
  processingTimeMs: number | null;
  bodyTruncated: boolean;
}

interface DeliveryDetail extends DeliveryEntry {
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  bodyRaw: string | null;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WebhookInspectorPanelProps {
  /** Webhook receiver id whose deliveries are being inspected. */
  webhookId: string;
  /** Human-readable name for the receiver — shown in the panel header. */
  webhookName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function SignatureBadge({ valid }: { valid: boolean | null }) {
  if (valid === null) {
    return (
      <Badge variant="secondary" className="gap-1 text-xs">
        <AlertCircle className="h-3 w-3" aria-hidden="true" />
        Not checked
      </Badge>
    );
  }
  if (valid) {
    return (
      <Badge variant="default" className="gap-1 bg-green-600 text-xs text-white hover:bg-green-600/80">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        Valid
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className="gap-1 text-xs">
      <XCircle className="h-3 w-3" aria-hidden="true" />
      Invalid
    </Badge>
  );
}

/**
 * Render a JSON value with basic color hints using CSS classes.
 * We intentionally avoid a full syntax-highlighting library here to keep
 * the bundle light — the body is read-only and the simple colorization is
 * sufficient for debugging purposes.
 */
function JsonBlock({ value }: { value: Record<string, unknown> | null }) {
  if (value === null) return <em className="text-[var(--color-muted-foreground)]">null</em>;

  const formatted = JSON.stringify(value, null, 2);
  return (
    <pre className="overflow-auto rounded-md bg-[var(--color-muted)] p-3 text-xs leading-relaxed">
      <code>{formatted}</code>
    </pre>
  );
}

// ---------------------------------------------------------------------------
// DeliveryDetailView — shown when a row is selected
// ---------------------------------------------------------------------------

function DeliveryDetailView({
  webhookId,
  deliveryId,
  onBack,
}: {
  webhookId: string;
  deliveryId: string;
  onBack: () => void;
}) {
  const client = useApiClient();

  const detailQuery = useQuery({
    queryKey: ["webhook-delivery-detail", webhookId, deliveryId],
    queryFn: ({ signal }) =>
      client.get<ApiResponse<DeliveryDetail>>(
        `/v1/webhooks/inbound/${webhookId}/deliveries/${deliveryId}`,
        undefined,
        { signal },
      ),
  });

  const detail = detailQuery.data?.data;

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-1 w-fit gap-1.5">
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        Back to deliveries
      </Button>

      {detailQuery.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : detailQuery.isError ? (
        <p className="text-sm text-[var(--color-destructive)]">
          Failed to load delivery detail.
        </p>
      ) : detail !== undefined ? (
        <>
          {/* Metadata row */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-[var(--color-muted-foreground)]">Received</dt>
              <dd>
                <RelativeTime value={detail.receivedAt} />
              </dd>
            </div>
            <div>
              <dt className="text-[var(--color-muted-foreground)]">Signature</dt>
              <dd>
                <SignatureBadge valid={detail.signatureValid} />
              </dd>
            </div>
            <div>
              <dt className="text-[var(--color-muted-foreground)]">Status</dt>
              <dd>
                <Badge variant="outline" className="text-xs">{detail.statusCode}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-[var(--color-muted-foreground)]">Timing</dt>
              <dd className="flex items-center gap-1 text-xs">
                <Clock className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden="true" />
                {detail.processingTimeMs !== null
                  ? `${detail.processingTimeMs} ms`
                  : "—"}
              </dd>
            </div>
          </dl>

          {detail.bodyTruncated && (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
              Body was truncated at 64 KiB before storage.
            </p>
          )}

          {/* Headers / Body tabs */}
          <Tabs defaultValue="body">
            <TabsList>
              <TabsTrigger value="body">Body</TabsTrigger>
              <TabsTrigger value="headers">
                Headers
                <span className="ml-1.5 rounded-full bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted-foreground)]">
                  {Object.keys(detail.headers).length}
                </span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="body" className="mt-3">
              {detail.body !== null ? (
                <JsonBlock value={detail.body} />
              ) : detail.bodyRaw !== null ? (
                <pre className="overflow-auto rounded-md bg-[var(--color-muted)] p-3 text-xs leading-relaxed">
                  <code>{detail.bodyRaw}</code>
                </pre>
              ) : (
                <p className="text-sm text-[var(--color-muted-foreground)]">No body.</p>
              )}
            </TabsContent>

            <TabsContent value="headers" className="mt-3">
              {Object.keys(detail.headers).length === 0 ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">No headers recorded.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(detail.headers).map(([name, value]) => (
                      <TableRow key={name}>
                        <TableCell className="font-mono text-xs">{name}</TableCell>
                        <TableCell className="max-w-[300px] truncate font-mono text-xs">
                          {value}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DeliveryListView — paginated table of recent deliveries
// ---------------------------------------------------------------------------

function DeliveryListView({
  webhookId,
  onSelectDelivery,
}: {
  webhookId: string;
  onSelectDelivery: (id: string) => void;
}) {
  const client = useApiClient();

  const listQuery = useQuery({
    queryKey: ["webhook-deliveries", webhookId],
    queryFn: ({ signal }) =>
      client.get<PaginatedResponse<DeliveryEntry>>(
        `/v1/webhooks/inbound/${webhookId}/deliveries`,
        { limit: 25 },
        { signal },
      ),
    // Refresh every 30 seconds while the panel is open so newly received
    // deliveries appear without requiring a manual page reload.
    refetchInterval: 30_000,
  });

  const deliveries = listQuery.data?.data ?? [];

  if (listQuery.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (listQuery.isError) {
    return (
      <p className="text-sm text-[var(--color-destructive)]">
        Failed to load delivery history.
      </p>
    );
  }

  if (deliveries.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-[var(--color-muted-foreground)]">
          No deliveries recorded yet. Send a POST to the webhook URL to see entries here.
        </p>
        {listQuery.isFetching && (
          <Loader2 className="mx-auto mt-2 h-4 w-4 animate-spin text-[var(--color-muted-foreground)]" aria-label="Loading" />
        )}
      </div>
    );
  }

  return (
    <>
      {listQuery.isFetching && !listQuery.isLoading && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Refreshing…
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Received</TableHead>
            <TableHead>Signature</TableHead>
            <TableHead>Timing</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {deliveries.map((d) => (
            <TableRow
              key={d.id}
              className="cursor-pointer hover:bg-[var(--color-muted)]/50"
              onClick={() => onSelectDelivery(d.id)}
              // Keyboard accessibility: allow Enter/Space to select
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectDelivery(d.id);
                }
              }}
            >
              <TableCell className="text-sm">
                <RelativeTime value={d.receivedAt} />
              </TableCell>
              <TableCell>
                <SignatureBadge valid={d.signatureValid} />
              </TableCell>
              <TableCell className="text-xs text-[var(--color-muted-foreground)]">
                {d.processingTimeMs !== null ? (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    {d.processingTimeMs} ms
                  </span>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="text-right">
                {d.bodyTruncated && (
                  <Badge variant="outline" className="text-[10px]">truncated</Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
        Showing {deliveries.length} of {listQuery.data?.pagination.total ?? "?"} deliveries.
        Up to 100 deliveries are retained per webhook.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// WebhookInspectorPanel — top-level exported component
// ---------------------------------------------------------------------------

export function WebhookInspectorPanel({
  webhookId,
  webhookName,
  open,
  onOpenChange,
}: WebhookInspectorPanelProps) {
  // Track which delivery (if any) the user has drilled into.
  const [selectedDeliveryId, setSelectedDeliveryId] = React.useState<string | null>(null);

  // Clear the detail selection when the panel is closed so the list view
  // is always shown fresh on re-open.
  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen) setSelectedDeliveryId(null);
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-[var(--color-border)] px-6 py-4">
          <DialogTitle>
            Delivery history — <span className="font-normal text-[var(--color-muted-foreground)]">{webhookName}</span>
          </DialogTitle>
          <DialogDescription>
            Inspect recent inbound deliveries. Deliveries are retained for up to 100 entries.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {selectedDeliveryId !== null ? (
            <DeliveryDetailView
              webhookId={webhookId}
              deliveryId={selectedDeliveryId}
              onBack={() => setSelectedDeliveryId(null)}
            />
          ) : (
            <DeliveryListView
              webhookId={webhookId}
              onSelectDelivery={setSelectedDeliveryId}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
