/**
 * ApiKeysPage — API key management: create/revoke/rotate keys, scope selection, last used.
 *
 * Route: /settings/api-keys
 *
 * API keys are server-generated; the full key is shown only once on creation.
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Trash2, Eye, EyeOff, RefreshCw, Search } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader.js";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form.js";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
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
import { CopyButton } from "@/components/shared/CopyButton.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { PaginatedResponse } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// Types & schema
// ---------------------------------------------------------------------------

interface ApiKey {
  id: string;
  name: string;
  scopes: string[];
  expiresAt?: string | null;
  lastUsedAt?: string;
  createdAt: string;
  /** Only present immediately after creation or rotation */
  key?: string;
}

const createKeySchema = z.object({
  name: z.string().min(1, "Name is required").max(64),
});
type CreateKeyValues = z.infer<typeof createKeySchema>;

type ExpiryPreset = "never" | "30d" | "90d" | "1y" | "custom";

function expiryPresetToDate(preset: ExpiryPreset): string | undefined {
  if (preset === "never" || preset === "custom") return undefined;
  const now = new Date();
  switch (preset) {
    case "30d": now.setDate(now.getDate() + 30); break;
    case "90d": now.setDate(now.getDate() + 90); break;
    case "1y": now.setFullYear(now.getFullYear() + 1); break;
  }
  return now.toISOString();
}

const AVAILABLE_SCOPES = [
  "data:read",
  "data:write",
  "ontology:read",
  "ontology:write",
  "pipelines:read",
  "pipelines:trigger",
  "pipelines:manage",
  "apps:read",
  "apps:deploy",
  "apps:manage",
  "plugins:read",
  "plugins:manage",
  "users:read",
  "users:manage",
  "logs:read",
  "logs:export",
  "audit:read",
  "webhooks:manage",
  "execution:read",
  "execution:run",
  "admin",
];

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "data:read": "Read data records, query datasets",
  "data:write": "Create, update, and delete data records",
  "ontology:read": "View object types, link types, and schemas",
  "ontology:write": "Create and modify object types and schemas",
  "pipelines:read": "View pipeline definitions and run history",
  "pipelines:trigger": "Trigger pipeline executions",
  "pipelines:manage": "Create, update, and delete pipelines",
  "apps:read": "View application configurations",
  "apps:deploy": "Deploy applications",
  "apps:manage": "Create, update, and delete applications",
  "plugins:read": "View installed plugins",
  "plugins:manage": "Install, update, and remove plugins",
  "users:read": "View user profiles and team members",
  "users:manage": "Invite, update roles, and remove users",
  "logs:read": "View audit logs and system events",
  "logs:export": "Export log data to external systems or files",
  "audit:read": "View detailed audit trail entries and compliance reports",
  "webhooks:manage": "Create, update, and delete webhooks",
  "execution:read": "View sandbox execution results and logs",
  "execution:run": "Execute code in sandboxed environments",
  "admin": "Full administrative access to all platform features",
};

// ---------------------------------------------------------------------------
// ApiKeysPage component
// ---------------------------------------------------------------------------

export function ApiKeysPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [revokeTarget, setRevokeTarget] = React.useState<ApiKey | null>(null);
  const [rotateTarget, setRotateTarget] = React.useState<ApiKey | null>(null);
  const [newKey, setNewKey] = React.useState<string | null>(null);
  const [rotatedKey, setRotatedKey] = React.useState<string | null>(null);
  const [showKey, setShowKey] = React.useState(false);
  const [showRotatedKey, setShowRotatedKey] = React.useState(false);
  const [selectedScopes, setSelectedScopes] = React.useState<string[]>([]);
  const [expiryPreset, setExpiryPreset] = React.useState<ExpiryPreset>("never");
  const [customExpiry, setCustomExpiry] = React.useState("");
  const [searchQuery, setSearchQuery] = React.useState("");

  const keysQuery = useQuery({
    queryKey: ["api-keys"],
    queryFn: ({ signal }) =>
      client.get<PaginatedResponse<ApiKey>>("/v1/api-keys", undefined, { signal }),
  });

  const allKeys = keysQuery.data?.data ?? [];
  const keys = searchQuery
    ? allKeys.filter((k) => k.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : allKeys;

  const form = useForm<CreateKeyValues>({
    resolver: zodResolver(createKeySchema),
    defaultValues: { name: "" },
  });

  const createMutation = useMutation({
    mutationFn: (values: CreateKeyValues) => {
      let expiresAt: string | undefined;
      if (expiryPreset === "custom" && customExpiry) {
        expiresAt = new Date(customExpiry).toISOString();
      } else {
        expiresAt = expiryPresetToDate(expiryPreset);
      }
      return client.post<ApiKey>("/v1/api-keys", {
        ...values,
        scopes: selectedScopes,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
    },
    onSuccess: (response) => {
      if (response.key !== undefined) {
        setNewKey(response.key);
      }
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
      form.reset();
      setSelectedScopes([]);
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Create failed.";
      toast({ title: "Create failed", description: message, variant: "destructive" });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (keyId: string) =>
      client.delete(`/v1/api-keys/${keyId}`),
    onSuccess: () => {
      toast({ title: "API key revoked" });
      setRevokeTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Revoke failed.";
      toast({ title: "Revoke failed", description: message, variant: "destructive" });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (keyId: string) =>
      client.post<{ id: string; key: string; keyPrefix: string; scopes: string[]; createdAt: string }>(
        `/v1/api-keys/${keyId}/rotate`,
      ),
    onSuccess: (response) => {
      setRotateTarget(null);
      setRotatedKey(response.key);
      void queryClient.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Rotation failed.";
      toast({ title: "Rotation failed", description: message, variant: "destructive" });
    },
  });

  function toggleScope(scope: string) {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  function handleCloseCreateDialog() {
    setCreateOpen(false);
    setNewKey(null);
    setShowKey(false);
    form.reset();
    setSelectedScopes([]);
    setExpiryPreset("never");
    setCustomExpiry("");
  }

  function handleCloseRotatedKeyDialog() {
    setRotatedKey(null);
    setShowRotatedKey(false);
  }

  return (
    <div>
      <PageHeader
        title="API Keys"
        description="Keys for programmatic access to the platform API."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            Create key
          </Button>
        }
      />

      <div className="mt-6">
        <div className="mb-4 flex items-center gap-2">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]" aria-hidden="true" />
            <Input
              placeholder="Search keys..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keysQuery.isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 5 }).map((__, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
                  No API keys. Create one to enable programmatic access.
                </TableCell>
              </TableRow>
            ) : (
              keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium">{key.name}</TableCell>
                  <TableCell className="text-xs text-[var(--color-muted-foreground)]">
                    {key.scopes.join(", ") || "No scopes"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {key.lastUsedAt !== undefined
                      ? <RelativeTime value={key.lastUsedAt} />
                      : <span className="text-[var(--color-muted-foreground)]">Never</span>
                    }
                  </TableCell>
                  <TableCell className="text-sm">
                    <RelativeTime value={key.createdAt} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setRotateTarget(key)}
                        aria-label={`Rotate key "${key.name}"`}
                      >
                        <RefreshCw className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-[var(--color-destructive)]"
                        onClick={() => setRevokeTarget(key)}
                        aria-label={`Revoke key "${key.name}"`}
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

      {/* Create key dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) handleCloseCreateDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {newKey !== null ? "Key created — save it now" : "Create API Key"}
            </DialogTitle>
            <DialogDescription>
              {newKey !== null
                ? "This is the only time the full key will be shown. Copy it to a safe place."
                : "Select scopes to grant this key access to specific API areas."
              }
            </DialogDescription>
          </DialogHeader>

          {newKey !== null ? (
            /* Post-creation: show key once */
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-md bg-[var(--color-muted)] px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">
                  {showKey ? newKey : "op_" + "•".repeat(newKey.length - 3)}
                </code>
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="shrink-0 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                  aria-label={showKey ? "Hide key" : "Reveal key"}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                <CopyButton value={newKey} label="Copy API key" />
              </div>
              <DialogFooter>
                <Button onClick={handleCloseCreateDialog}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
            /* Create form */
            <Form {...form}>
              <form
                onSubmit={(e) => void form.handleSubmit((v) => createMutation.mutate(v))(e)}
                className="space-y-4"
              >
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Key name</FormLabel>
                      <FormControl>
                        <Input placeholder="CI/CD pipeline" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <fieldset>
                  <legend className="mb-2 text-sm font-medium">Scopes</legend>
                  <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                    {AVAILABLE_SCOPES.map((scope) => (
                      <label key={scope} className="flex cursor-pointer items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selectedScopes.includes(scope)}
                          onChange={() => toggleScope(scope)}
                          className="mt-0.5 h-4 w-4 shrink-0 rounded border-[var(--color-input)] accent-[var(--color-primary)]"
                        />
                        <div className="min-w-0">
                          <code className="font-mono text-xs">{scope}</code>
                          {SCOPE_DESCRIPTIONS[scope] !== undefined && (
                            <p className="text-xs text-[var(--color-muted-foreground)] leading-tight">
                              {SCOPE_DESCRIPTIONS[scope]}
                            </p>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Expires</label>
                  <Select
                    value={expiryPreset}
                    onValueChange={(v) => {
                      setExpiryPreset(v as ExpiryPreset);
                      if (v !== "custom") setCustomExpiry("");
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="never">Never</SelectItem>
                      <SelectItem value="30d">30 days</SelectItem>
                      <SelectItem value="90d">90 days</SelectItem>
                      <SelectItem value="1y">1 year</SelectItem>
                      <SelectItem value="custom">Custom date</SelectItem>
                    </SelectContent>
                  </Select>
                  {expiryPreset === "custom" && (
                    <Input
                      type="date"
                      value={customExpiry}
                      onChange={(e) => setCustomExpiry(e.target.value)}
                      min={new Date().toISOString().split("T")[0]}
                    />
                  )}
                </div>

                <DialogFooter>
                  <Button variant="outline" type="button" onClick={handleCloseCreateDialog}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={createMutation.isPending}
                    aria-busy={createMutation.isPending}
                  >
                    {createMutation.isPending ? "Creating…" : "Create key"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
        title="Revoke API key"
        description={`Revoke "${revokeTarget?.name ?? "this key"}"? Any integrations using it will stop working immediately.`}
        confirmLabel="Revoke key"
        onConfirm={() => {
          if (revokeTarget !== null) revokeMutation.mutate(revokeTarget.id);
        }}
        isLoading={revokeMutation.isPending}
      />

      <ConfirmDialog
        open={rotateTarget !== null}
        onOpenChange={(open) => { if (!open) setRotateTarget(null); }}
        title="Rotate API key"
        description={`Rotating "${rotateTarget?.name ?? "this key"}" will generate a new key value. The old key will stop working immediately. Continue?`}
        confirmLabel="Rotate key"
        onConfirm={() => {
          if (rotateTarget !== null) rotateMutation.mutate(rotateTarget.id);
        }}
        isLoading={rotateMutation.isPending}
      />

      <Dialog open={rotatedKey !== null} onOpenChange={(open) => { if (!open) handleCloseRotatedKeyDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Key rotated — save the new key now</DialogTitle>
            <DialogDescription>
              This is the only time the new key will be shown. Copy it to a safe place.
            </DialogDescription>
          </DialogHeader>
          {rotatedKey !== null && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-md bg-[var(--color-muted)] px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">
                  {showRotatedKey ? rotatedKey : "op_" + "•".repeat(Math.max(0, rotatedKey.length - 3))}
                </code>
                <button
                  type="button"
                  onClick={() => setShowRotatedKey((v) => !v)}
                  className="shrink-0 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                  aria-label={showRotatedKey ? "Hide key" : "Reveal key"}
                >
                  {showRotatedKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                <CopyButton value={rotatedKey} label="Copy API key" />
              </div>
              <DialogFooter>
                <Button onClick={handleCloseRotatedKeyDialog}>Done</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
