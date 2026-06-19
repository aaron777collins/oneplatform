/**
 * AdminPage — platform admin only: tenant settings, system config, danger zone.
 *
 * Route: /settings/admin
 *
 * Only platform-admin and tenant-admin roles can access this page.
 * The route guard prevents unauthorized access, but this page also enforces
 * the permission check inline to provide a clear message if reached incorrectly.
 *
 * Tenant settings form is wired to:
 *   GET  /api/v1/tenants/:tenantId — fetch current config
 *   PATCH /api/v1/tenants/:tenantId — update tenant name / settings
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Shield, RotateCcw, Info } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { usePermission } from "@/hooks/use-auth.js";
import { useSession } from "@/hooks/use-auth.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";

// ---------------------------------------------------------------------------
// Types & schema
// ---------------------------------------------------------------------------

interface TenantResponse {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const tenantSchema = z.object({
  tenantName: z.string().min(2, "Name must be at least 2 characters").max(64),
});
type TenantValues = z.infer<typeof tenantSchema>;

// ---------------------------------------------------------------------------
// AdminPage component
// ---------------------------------------------------------------------------

export function AdminPage() {
  const isAdmin = usePermission("tenant-admin");
  const { tenantId } = useSession();
  const client = useApiClient();
  const queryClient = useQueryClient();

  const [rotateKeyOpen, setRotateKeyOpen] = React.useState(false);

  // Fetch current tenant configuration
  const configQuery = useQuery({
    queryKey: ["tenant-config", tenantId],
    enabled: tenantId !== null,
    queryFn: ({ signal }) =>
      client.get<{ id: string; name: string; slug: string; settings: Record<string, unknown>; createdAt: string; updatedAt: string }>(
        `/v1/tenants/${tenantId}`,
        undefined,
        { signal },
      ),
  });

  const tenantData = configQuery.data as TenantResponse | undefined;

  const form = useForm<TenantValues>({
    resolver: zodResolver(tenantSchema),
    values: { tenantName: tenantData?.name ?? "" },
  });

  const updateConfigMutation = useMutation({
    mutationFn: (values: TenantValues) =>
      client.patch<TenantResponse>(`/v1/tenants/${tenantId}`, {
        name: values.tenantName,
      }),
    onSuccess: () => {
      toast({ title: "Settings saved", description: "Tenant settings have been updated." });
      void queryClient.invalidateQueries({ queryKey: ["tenant-config", tenantId] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Failed to save settings.";
      toast({ title: "Save failed", description: message, variant: "destructive" });
    },
  });

  const rotateMasterKeyMutation = useMutation({
    mutationFn: () =>
      Promise.reject(new Error("Master key rotation API is not yet available")),
    onError: () => {
      toast({ title: "Not available", description: "Master key rotation is coming soon.", variant: "destructive" });
      setRotateKeyOpen(false);
    },
  });

  if (!isAdmin) {
    return (
      <div>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Shield className="mb-4 h-12 w-12 text-[var(--color-muted-foreground)]" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Admin access required</h2>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            You need tenant-admin or platform-admin role to access this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Admin"
        description="Platform and tenant configuration. Changes take effect immediately."
      />

      <div className="mt-6 max-w-lg space-y-6">
        {/* Tenant config */}
        <div className="rounded-lg border border-[var(--color-border)] p-4">
          <h2 className="mb-4 text-sm font-semibold">Tenant settings</h2>
          {configQuery.isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-9 w-28" />
            </div>
          ) : configQuery.isError ? (
            <div className="rounded-lg border border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/5 p-3 text-sm text-[var(--color-destructive)]">
              Failed to load tenant configuration. You may not have sufficient permissions.
            </div>
          ) : (
            <Form {...form}>
              <form
                onSubmit={(e) => void form.handleSubmit((v) => updateConfigMutation.mutate(v))(e)}
                className="space-y-4"
              >
                <FormField
                  control={form.control}
                  name="tenantName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Organization name</FormLabel>
                      <FormControl><Input {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  type="submit"
                  disabled={updateConfigMutation.isPending || !form.formState.isDirty}
                  aria-busy={updateConfigMutation.isPending}
                >
                  {updateConfigMutation.isPending ? "Saving..." : "Save settings"}
                </Button>
              </form>
            </Form>
          )}
        </div>

        {/* Danger zone */}
        <div className="rounded-lg border border-[var(--color-destructive)]/30 p-4 space-y-4">
          <h2 className="text-sm font-semibold text-[var(--color-destructive)]">Danger zone</h2>

          {/* Coming Soon banner — only for master key rotation */}
          <div className="flex items-start gap-3 rounded-lg border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              Master key rotation is under active development and will be available in a future release.
            </p>
          </div>

          <div>
            <p className="mb-2 text-sm text-[var(--color-muted-foreground)]">
              Rotate the platform master key. All secrets encrypted with the current key will be
              re-encrypted automatically. This operation may take several minutes.
            </p>
            <Button
              variant="destructive"
              size="sm"
              disabled
              aria-disabled="true"
            >
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
              Rotate master key
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={rotateKeyOpen}
        onOpenChange={setRotateKeyOpen}
        title="Rotate master key?"
        description="This will re-encrypt all platform secrets. The operation runs in the background and may take several minutes. Platform functionality is not interrupted."
        confirmLabel="Rotate key"
        onConfirm={() => rotateMasterKeyMutation.mutate()}
        isLoading={rotateMasterKeyMutation.isPending}
      />
    </div>
  );
}
