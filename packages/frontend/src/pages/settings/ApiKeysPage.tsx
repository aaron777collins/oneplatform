/**
 * ApiKeysPage — API key management: create/revoke keys, scope selection, last used.
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
import { Plus, Trash2, Eye, EyeOff } from "lucide-react";
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
  lastUsedAt?: string;
  createdAt: string;
  /** Only present immediately after creation */
  key?: string;
}

const createKeySchema = z.object({
  name: z.string().min(1, "Name is required").max(64),
});
type CreateKeyValues = z.infer<typeof createKeySchema>;

const AVAILABLE_SCOPES = [
  "data:read",
  "data:write",
  "pipelines:run",
  "apps:deploy",
  "connectors:manage",
];

// ---------------------------------------------------------------------------
// ApiKeysPage component
// ---------------------------------------------------------------------------

export function ApiKeysPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [revokeTarget, setRevokeTarget] = React.useState<ApiKey | null>(null);
  const [newKey, setNewKey] = React.useState<string | null>(null);
  const [showKey, setShowKey] = React.useState(false);
  const [selectedScopes, setSelectedScopes] = React.useState<string[]>([]);

  const keysQuery = useQuery({
    queryKey: ["api-keys"],
    queryFn: ({ signal }) =>
      client.get<PaginatedResponse<ApiKey>>("/v1/api-keys", undefined, { signal }),
  });

  const keys = keysQuery.data?.data ?? [];

  const form = useForm<CreateKeyValues>({
    resolver: zodResolver(createKeySchema),
    defaultValues: { name: "" },
  });

  const createMutation = useMutation({
    mutationFn: (values: CreateKeyValues) =>
      client.post<{ data: ApiKey }>("/v1/api-keys", {
        ...values,
        scopes: selectedScopes,
      }),
    onSuccess: (response) => {
      if (response.data.key !== undefined) {
        setNewKey(response.data.key);
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
  }

  return (
    <main id="main-content" tabIndex={-1} className="flex-1 p-6">
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
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-[var(--color-destructive)]"
                      onClick={() => setRevokeTarget(key)}
                      aria-label={`Revoke key "${key.name}"`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
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
                  <div className="space-y-2">
                    {AVAILABLE_SCOPES.map((scope) => (
                      <label key={scope} className="flex cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selectedScopes.includes(scope)}
                          onChange={() => toggleScope(scope)}
                          className="h-4 w-4 rounded border-[var(--color-input)] accent-[var(--color-primary)]"
                        />
                        <code className="font-mono text-xs">{scope}</code>
                      </label>
                    ))}
                  </div>
                </fieldset>

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
    </main>
  );
}
