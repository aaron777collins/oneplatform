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
import { useMutation } from "@tanstack/react-query";
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
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { usePermission } from "@/hooks/use-auth.js";
// useApiClient not needed until admin config endpoints are implemented
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

  const [rotateKeyOpen, setRotateKeyOpen] = React.useState(false);

  // Admin config endpoints are not yet implemented on the backend.
  // The UI is kept as a preview with disabled controls.
  const configQuery = {
    isLoading: false,
    data: undefined as { data: TenantConfig } | undefined,
  };

  const form = useForm<TenantValues>({
    resolver: zodResolver(tenantSchema),
    values: { tenantName: "" },
  });

  const updateConfigMutation = useMutation({
    mutationFn: (_values: TenantValues) =>
      Promise.reject(new Error("Admin config API is not yet available")),
    onError: () => {
      toast({ title: "Not available", description: "Admin configuration is coming soon.", variant: "destructive" });
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
        {/* Coming Soon banner */}
        <div className="flex items-start gap-3 rounded-lg border border-[var(--color-primary)]/30 bg-[var(--color-primary)]/5 p-4">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">Coming Soon</p>
            <p className="mt-0.5 text-sm text-[var(--color-muted-foreground)]">
              Admin configuration and master key rotation are under active development.
              These features will be available in a future release. The layout below is a preview.
            </p>
          </div>
        </div>

        {/* Tenant config */}
        <div className="rounded-lg border border-[var(--color-border)] p-4 opacity-60">
          <h2 className="mb-4 text-sm font-semibold">Tenant settings</h2>
          <Form {...form}>
            <form
              onSubmit={(e) => { e.preventDefault(); }}
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="tenantName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Organization name</FormLabel>
                    <FormControl><Input {...field} disabled /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button
                type="submit"
                disabled
                aria-disabled="true"
              >
                Save settings
              </Button>
            </form>
          </Form>
        </div>

        {/* Danger zone */}
        <div className="rounded-lg border border-[var(--color-destructive)]/30 p-4 space-y-4 opacity-60">
          <h2 className="text-sm font-semibold text-[var(--color-destructive)]">Danger zone</h2>

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
