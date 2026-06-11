/**
 * AdminPage — platform admin only: tenant settings, system config, danger zone.
 *
 * Route: /settings/admin
 *
 * Only platform-admin and tenant-admin roles can access this page.
 * The route guard prevents unauthorized access, but this page also enforces
 * the permission check inline to provide a clear message if reached incorrectly.
 */
import * as React from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Shield, RotateCcw } from "lucide-react";
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
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";

// ---------------------------------------------------------------------------
// Types & schema
// ---------------------------------------------------------------------------

interface TenantConfig {
  tenantName: string;
  maxApps: number;
  maxConnectors: number;
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
  const client = useApiClient();

  const [rotateKeyOpen, setRotateKeyOpen] = React.useState(false);

  const configQuery = useQuery({
    queryKey: ["admin", "tenant-config"],
    queryFn: ({ signal }) =>
      client.get<{ data: TenantConfig }>("/v1/admin/config", undefined, { signal }),
    enabled: isAdmin,
  });

  const form = useForm<TenantValues>({
    resolver: zodResolver(tenantSchema),
    values: configQuery.data !== undefined
      ? { tenantName: configQuery.data.data.tenantName }
      : { tenantName: "" },
  });

  const updateConfigMutation = useMutation({
    mutationFn: (values: TenantValues) =>
      client.patch("/v1/admin/config", values),
    onSuccess: () => {
      toast({ title: "Configuration saved" });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Save failed.";
      toast({ title: "Save failed", description: message, variant: "destructive" });
    },
  });

  const rotateMasterKeyMutation = useMutation({
    mutationFn: () => client.post("/v1/admin/rotate-master-key"),
    onSuccess: () => {
      toast({ title: "Master key rotation initiated" });
      setRotateKeyOpen(false);
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Rotation failed.";
      toast({ title: "Rotation failed", description: message, variant: "destructive" });
      setRotateKeyOpen(false);
    },
  });

  if (!isAdmin) {
    return (
      <main id="main-content" tabIndex={-1} className="flex-1 p-6">
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Shield className="mb-4 h-12 w-12 text-[var(--color-muted-foreground)]" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Admin access required</h2>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            You need tenant-admin or platform-admin role to access this page.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main id="main-content" tabIndex={-1} className="flex-1 p-6">
      <PageHeader
        title="Admin"
        description="Platform and tenant configuration. Changes take effect immediately."
      />

      <div className="mt-6 max-w-lg space-y-6">
        {/* Tenant config */}
        <div className="rounded-lg border border-[var(--color-border)] p-4">
          <h2 className="mb-4 text-sm font-semibold">Tenant settings</h2>
          {configQuery.isLoading ? (
            <Skeleton className="h-20 w-full" />
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

                {/* Read-only limits */}
                {configQuery.data !== undefined && (
                  <dl className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <dt className="text-[var(--color-muted-foreground)]">Max apps</dt>
                      <dd className="font-medium">{configQuery.data.data.maxApps}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--color-muted-foreground)]">Max connectors</dt>
                      <dd className="font-medium">{configQuery.data.data.maxConnectors}</dd>
                    </div>
                  </dl>
                )}

                <Button
                  type="submit"
                  disabled={updateConfigMutation.isPending}
                  aria-busy={updateConfigMutation.isPending}
                >
                  {updateConfigMutation.isPending ? "Saving…" : "Save settings"}
                </Button>
              </form>
            </Form>
          )}
        </div>

        {/* Danger zone */}
        <div className="rounded-lg border border-[var(--color-destructive)]/30 p-4 space-y-4">
          <h2 className="text-sm font-semibold text-[var(--color-destructive)]">Danger zone</h2>

          <div>
            <p className="mb-2 text-sm text-[var(--color-muted-foreground)]">
              Rotate the platform master key. All secrets encrypted with the current key will be
              re-encrypted automatically. This operation may take several minutes.
            </p>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setRotateKeyOpen(true)}
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
    </main>
  );
}
