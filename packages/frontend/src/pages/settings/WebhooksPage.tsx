/**
 * WebhooksPage — outbound webhook management: URL, events, secret, test button.
 *
 * Route: /settings/webhooks
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Trash2, TestTube, Search } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form.js";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { PaginatedResponse } from "@/lib/api-client.js";
import { WebhookInspectorPanel } from "./WebhookInspectorPanel.js";

// ---------------------------------------------------------------------------
// Types & schema
// ---------------------------------------------------------------------------

interface Webhook {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
  lastDeliveryAt?: string;
  lastDeliveryStatus?: "success" | "failure";
}

// ---------------------------------------------------------------------------
// Human-readable event labels grouped by category
// ---------------------------------------------------------------------------

interface EventDefinition {
  event: string;
  label: string;
}

interface EventCategory {
  category: string;
  events: EventDefinition[];
}

const EVENT_CATEGORIES: EventCategory[] = [
  {
    category: "Pipelines",
    events: [
      { event: "pipeline.completed", label: "Pipeline completed successfully" },
      { event: "pipeline.failed", label: "Pipeline run failed" },
    ],
  },
  {
    category: "Builds",
    events: [
      { event: "build.success", label: "Build succeeded" },
      { event: "build.failed", label: "Build failed" },
    ],
  },
  {
    category: "Connectors",
    events: [
      { event: "connector.sync.completed", label: "Connector sync completed" },
    ],
  },
  {
    category: "System",
    events: [
      { event: "dlq.job.added", label: "Dead-letter queue job added" },
    ],
  },
];

const ALL_EVENTS = EVENT_CATEGORIES.flatMap((cat) => cat.events.map((e) => e.event));

const EVENT_LABEL_MAP: Record<string, string> = Object.fromEntries(
  EVENT_CATEGORIES.flatMap((cat) => cat.events.map((e) => [e.event, e.label])),
);

const webhookSchema = z.object({
  url: z
    .string()
    .url("Enter a valid HTTPS URL")
    // Positively require https:// rather than merely rejecting http://.
    // A negative check would silently accept other non-http schemes (ftp://,
    // file://, custom schemes) that would fail at delivery time with no
    // user-facing explanation.
    .refine(
      (val) => val.startsWith("https://"),
      "Webhook URLs must use HTTPS. Plain HTTP endpoints are insecure and may expose your signing secret.",
    ),
  secret: z.string().optional(),
});
type WebhookValues = z.infer<typeof webhookSchema>;

// ---------------------------------------------------------------------------
// WebhooksPage component
// ---------------------------------------------------------------------------

export function WebhooksPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<Webhook | null>(null);
  const [selectedEvents, setSelectedEvents] = React.useState<string[]>([]);

  // Inspector panel state — null means closed.
  const [inspectorTarget, setInspectorTarget] = React.useState<Webhook | null>(null);

  const webhooksQuery = useQuery({
    queryKey: ["webhooks"],
    queryFn: ({ signal }) =>
      client.get<PaginatedResponse<Webhook>>("/v1/webhooks", undefined, { signal }),
  });

  const webhooksInner = (webhooksQuery.data as unknown as { data?: PaginatedResponse<Webhook> })?.data ?? webhooksQuery.data;
  const webhooks = webhooksInner?.data ?? [];

  const form = useForm<WebhookValues>({
    resolver: zodResolver(webhookSchema),
    defaultValues: { url: "", secret: "" },
  });

  const createMutation = useMutation({
    mutationFn: (values: WebhookValues) =>
      client.post("/v1/webhooks", {
        url: values.url,
        events: selectedEvents,
        ...(values.secret !== undefined && values.secret !== "" ? { secret: values.secret } : {}),
      }),
    onSuccess: () => {
      toast({ title: "Webhook created" });
      form.reset();
      setSelectedEvents([]);
      setCreateOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Create failed.";
      toast({ title: "Create failed", description: message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.delete(`/v1/webhooks/${id}`),
    onSuccess: () => {
      toast({ title: "Webhook deleted" });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Delete failed.";
      toast({ title: "Delete failed", description: message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: (id: string) =>
      client.post(`/v1/webhooks/${id}/test`),
    onSuccess: () => toast({ title: "Test delivery sent" }),
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Test failed.";
      toast({ title: "Test failed", description: message, variant: "destructive" });
    },
  });

  function toggleEvent(event: string) {
    setSelectedEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  }

  return (
    <div>
      <PageHeader
        title="Webhooks"
        description="Receive HTTP notifications when platform events occur."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Add webhook
          </Button>
        }
      />

      <div className="mt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Last delivery</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {webhooksQuery.isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 5 }).map((__, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : webhooks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
                  No webhooks configured.
                </TableCell>
              </TableRow>
            ) : (
              webhooks.map((webhook) => (
                <TableRow key={webhook.id}>
                  <TableCell className="max-w-[200px] truncate font-mono text-xs">
                    {webhook.url}
                  </TableCell>
                  <TableCell className="text-xs text-[var(--color-muted-foreground)]">
                    {(webhook.events ?? []).length === 0
                      ? "All events"
                      : (webhook.events ?? []).map((e) => EVENT_LABEL_MAP[e] ?? e).join(", ")}
                  </TableCell>
                  <TableCell className="text-sm">
                    {webhook.lastDeliveryAt !== undefined ? (
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            webhook.lastDeliveryStatus === "success"
                              ? "bg-green-500"
                              : "bg-red-500"
                          }`}
                          aria-hidden="true"
                        />
                        <span className="text-xs font-medium">
                          {webhook.lastDeliveryStatus === "success" ? "OK" : "Failed"}
                        </span>
                        <RelativeTime value={webhook.lastDeliveryAt} />
                      </span>
                    ) : (
                      <span className="text-[var(--color-muted-foreground)]">Never</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    <RelativeTime value={webhook.createdAt} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setInspectorTarget(webhook)}
                        aria-label="Inspect webhook deliveries"
                        title="Inspect deliveries"
                      >
                        <Search className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => testMutation.mutate(webhook.id)}
                        disabled={testMutation.isPending}
                        aria-label="Test webhook delivery"
                      >
                        <TestTube className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-[var(--color-destructive)]"
                        onClick={() => setDeleteTarget(webhook)}
                        aria-label="Delete webhook"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create webhook dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Webhook</DialogTitle>
            <DialogDescription>
              Configure an endpoint to receive platform event notifications.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={(e) => void form.handleSubmit((v) => createMutation.mutate(v))(e)}
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Endpoint URL <span className="text-[var(--color-destructive)]" aria-hidden>*</span></FormLabel>
                    <FormControl>
                      <Input placeholder="https://example.com/webhook" type="url" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="secret"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Signing secret</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        placeholder="Optional HMAC secret"
                        autoComplete="new-password"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Used to sign the X-Webhook-Signature header. Leave blank to skip signing.
                      {/* TODO(OP-webhook-autosecret): If the API is updated to auto-generate a
                          signing secret on creation, display it in a post-create dialog with
                          a CopyButton (shared/CopyButton) — the secret is write-only after that
                          point and cannot be recovered from the API. */}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <fieldset>
                <legend className="mb-2 text-sm font-medium">Events to subscribe</legend>
                <div className="space-y-3">
                  {EVENT_CATEGORIES.map((cat) => (
                    <div key={cat.category}>
                      <p className="text-xs font-semibold text-[var(--color-muted-foreground)] uppercase tracking-wide mb-1.5">
                        {cat.category}
                      </p>
                      <div className="space-y-1.5 pl-1">
                        {cat.events.map(({ event, label }) => (
                          <label key={event} className="flex cursor-pointer items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={selectedEvents.includes(event)}
                              onChange={() => toggleEvent(event)}
                              className="h-4 w-4 rounded border-[var(--color-input)] accent-[var(--color-primary)]"
                            />
                            <span className="text-xs">{label}</span>
                            <code className="font-mono text-[10px] text-[var(--color-muted-foreground)]">{event}</code>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </fieldset>

              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setCreateOpen(false)}>Cancel</Button>
                <Button
                  type="submit"
                  disabled={createMutation.isPending}
                  aria-busy={createMutation.isPending}
                >
                  {createMutation.isPending ? "Adding…" : "Add webhook"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete webhook"
        description={`Delete the webhook for "${deleteTarget?.url ?? ""}"? No further deliveries will be sent.`}
        confirmLabel="Delete webhook"
        onConfirm={() => {
          if (deleteTarget !== null) deleteMutation.mutate(deleteTarget.id);
        }}
        isLoading={deleteMutation.isPending}
      />

      {inspectorTarget !== null && (
        <WebhookInspectorPanel
          webhookId={inspectorTarget.id}
          webhookName={inspectorTarget.url}
          open={inspectorTarget !== null}
          onOpenChange={(open) => { if (!open) setInspectorTarget(null); }}
        />
      )}
    </div>
  );
}
