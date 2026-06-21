/**
 * AdminPage — platform admin only: system stats, activity feed, tenant settings,
 * danger zone, and quick links to common admin tasks (PA-020).
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
 *
 * System stats are fetched from /v1/admin/stats. When the endpoint is
 * unavailable (not yet implemented), mock values are shown with a note.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Shield,
  RotateCcw,
  Info,
  Users,
  Building2,
  Activity,
  GitBranch,
  Key,
  FileText,
  HeartPulse,
  ExternalLink,
} from "lucide-react";
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
import { Badge } from "@/components/ui/badge.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { FormDescription } from "@/components/ui/form.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { usePermission } from "@/hooks/use-auth.js";
import { useSession } from "@/hooks/use-auth.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";

// ---------------------------------------------------------------------------
// Types & schema
// ---------------------------------------------------------------------------

interface TenantPreferences {
  timezone?: string;
  dateFormat?: string;
  defaultPageSize?: number;
}

interface TenantResponse {
  id: string;
  name: string;
  slug: string;
  settings: TenantPreferences & Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// Date format options — ordered from ISO standard (unambiguous) to locale formats.
const DATE_FORMAT_OPTIONS = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY"] as const;
type DateFormat = (typeof DATE_FORMAT_OPTIONS)[number];

// Pagination options — powers of 10 cover the typical needs without going huge.
const PAGINATION_OPTIONS = [10, 25, 50, 100] as const;
type PaginationSize = (typeof PAGINATION_OPTIONS)[number];

const tenantSchema = z.object({
  tenantName: z.string().min(2, "Name must be at least 2 characters").max(64),
  // Tenant preferences (PA-009)
  timezone: z.string().min(1, "Timezone is required"),
  dateFormat: z.enum(DATE_FORMAT_OPTIONS),
  defaultPageSize: z.coerce.number().refine(
    (v): v is PaginationSize => (PAGINATION_OPTIONS as readonly number[]).includes(v),
    { message: "Must be 10, 25, 50, or 100" },
  ),
});
type TenantValues = z.infer<typeof tenantSchema>;

interface SystemStats {
  userCount:       number;
  tenantCount:     number;
  activeSessions:  number;
  pipelineCount:   number;
}

interface ActivityEvent {
  id:        string;
  type:      string;
  actor:     string;
  resource:  string;
  timestamp: string;
}

interface AdminStatsResponse {
  stats:    SystemStats;
  activity: ActivityEvent[];
}

// Fallback when /v1/admin/stats is not yet available — avoids a blank page
const MOCK_STATS: AdminStatsResponse = {
  stats: {
    userCount:      12,
    tenantCount:    1,
    activeSessions: 3,
    pipelineCount:  7,
  },
  activity: [
    { id: "1", type: "USER_LOGIN",       actor: "alice@acme.com",   resource: "session",      timestamp: new Date(Date.now() - 5 * 60_000).toISOString() },
    { id: "2", type: "PIPELINE_RUN",     actor: "system",           resource: "pipeline:etl", timestamp: new Date(Date.now() - 15 * 60_000).toISOString() },
    { id: "3", type: "ENTITY_CREATED",   actor: "bob@acme.com",     resource: "entity:Order", timestamp: new Date(Date.now() - 60 * 60_000).toISOString() },
    { id: "4", type: "API_KEY_CREATED",  actor: "alice@acme.com",   resource: "api-key:ci",   timestamp: new Date(Date.now() - 2 * 3600_000).toISOString() },
    { id: "5", type: "CONNECTOR_SYNCED", actor: "system",           resource: "connector:pg", timestamp: new Date(Date.now() - 3 * 3600_000).toISOString() },
  ],
};

// ---------------------------------------------------------------------------
// Icon wrapper type
//
// exactOptionalPropertyTypes causes lucide's `className?: string | undefined`
// to be incompatible with `className?: string`. We work around this the same
// way the rest of the codebase does: define the prop type as
// `string | undefined` to match what lucide actually emits.
// ---------------------------------------------------------------------------

type IconComponent = React.ComponentType<{ className?: string | undefined }>;

// ---------------------------------------------------------------------------
// StatCard — a single system stat KPI card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  icon: Icon,
  isLoading,
}: {
  label:     string;
  value:     number;
  icon:      IconComponent;
  isLoading: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden="true" />
        <span className="text-xs font-medium text-[var(--color-muted-foreground)]">{label}</span>
      </div>
      {isLoading ? (
        <Skeleton className="h-7 w-16" />
      ) : (
        <p className="text-2xl font-bold">{value.toLocaleString()}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick links for common admin tasks
// ---------------------------------------------------------------------------

const QUICK_LINKS: Array<{ label: string; description: string; to: string; icon: IconComponent }> = [
  { label: "Manage users",  description: "View and edit team members",   to: "/settings/teams",    icon: Users },
  { label: "View logs",     description: "Browse platform audit logs",   to: "/logs/audit",        icon: FileText },
  { label: "API Keys",      description: "Manage API credentials",       to: "/settings/api-keys", icon: Key },
  { label: "Check health",  description: "View service health status",   to: "/metrics",           icon: HeartPulse },
  { label: "Pipelines",     description: "Monitor data pipelines",       to: "/pipelines",         icon: GitBranch },
];

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

  // Fetch system stats and recent activity (PA-020).
  // Falls back to MOCK_STATS when the endpoint is not yet implemented so the
  // admin UI is always usable, even against an older API version.
  const statsQuery = useQuery({
    queryKey: ["admin-stats"],
    queryFn: ({ signal }) =>
      client.get<AdminStatsResponse>("/v1/admin/stats", undefined, { signal }),
    retry: false,
    placeholderData: MOCK_STATS,
  });

  const adminData: AdminStatsResponse = statsQuery.data ?? MOCK_STATS;
  const isMockData = statsQuery.isError && !statsQuery.data;

  const tenantData = configQuery.data as TenantResponse | undefined;

  const form = useForm<TenantValues>({
    resolver: zodResolver(tenantSchema),
    values: {
      tenantName: tenantData?.name ?? "",
      timezone: (tenantData?.settings.timezone as string | undefined) ?? "UTC",
      dateFormat: ((tenantData?.settings.dateFormat as string | undefined) ?? "YYYY-MM-DD") as TenantValues["dateFormat"],
      defaultPageSize: ((tenantData?.settings.defaultPageSize as number | undefined) ?? 25) as TenantValues["defaultPageSize"],
    },
  });

  const updateConfigMutation = useMutation({
    mutationFn: (values: TenantValues) =>
      client.patch<TenantResponse>(`/v1/tenants/${tenantId}`, {
        name: values.tenantName,
        settings: {
          timezone: values.timezone,
          dateFormat: values.dateFormat,
          defaultPageSize: values.defaultPageSize,
        },
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

      <div className="mt-6 space-y-8 max-w-3xl">

        {/* System stats (PA-020) */}
        <section aria-labelledby="system-stats-heading">
          <div className="flex items-center justify-between mb-3">
            <h2 id="system-stats-heading" className="text-sm font-semibold">System overview</h2>
            {isMockData && (
              <Badge variant="outline" className="text-[10px]">
                <Info className="h-3 w-3 mr-1" aria-hidden="true" />
                Sample data — /v1/admin/stats not available
              </Badge>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Users"            value={adminData.stats.userCount}       icon={Users}     isLoading={statsQuery.isLoading} />
            <StatCard label="Tenants"          value={adminData.stats.tenantCount}     icon={Building2} isLoading={statsQuery.isLoading} />
            <StatCard label="Active sessions"  value={adminData.stats.activeSessions}  icon={Activity}  isLoading={statsQuery.isLoading} />
            <StatCard label="Pipelines"        value={adminData.stats.pipelineCount}   icon={GitBranch} isLoading={statsQuery.isLoading} />
          </div>
        </section>

        {/* Quick links to common admin tasks (PA-020) */}
        <section aria-labelledby="quick-links-heading">
          <h2 id="quick-links-heading" className="mb-3 text-sm font-semibold">Quick links</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {QUICK_LINKS.map(({ label, description, to, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-3 text-sm transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
              >
                <Icon className="h-4 w-4 shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-medium">{label}</p>
                  <p className="text-xs text-[var(--color-muted-foreground)] truncate">{description}</p>
                </div>
                <ExternalLink className="h-3 w-3 ml-auto shrink-0 text-[var(--color-muted-foreground)]" aria-hidden="true" />
              </Link>
            ))}
          </div>
        </section>

        {/* Recent activity feed — last 10 events (PA-020) */}
        <section aria-labelledby="activity-heading">
          <h2 id="activity-heading" className="mb-3 text-sm font-semibold">Recent activity</h2>
          {statsQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : adminData.activity.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">No recent activity.</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
              {adminData.activity.slice(0, 10).map((event) => (
                <li key={event.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <div className="flex items-center gap-3 min-w-0">
                    <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
                      {event.type}
                    </Badge>
                    <span className="truncate text-[var(--color-muted-foreground)]">
                      <span className="font-medium text-[var(--color-foreground)]">{event.actor}</span>
                      {" — "}
                      {event.resource}
                    </span>
                  </div>
                  <RelativeTime value={event.timestamp} className="ml-4 shrink-0 text-xs text-[var(--color-muted-foreground)]" />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Tenant config */}
        <section aria-labelledby="tenant-config-heading">
          <h2 id="tenant-config-heading" className="mb-3 text-sm font-semibold">Tenant settings</h2>
          <div className="max-w-lg rounded-lg border border-[var(--color-border)] p-4">
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
                  {/* Display name */}
                  <FormField
                    control={form.control}
                    name="tenantName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Organization display name</FormLabel>
                        <FormControl><Input {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Timezone (PA-009) — free-text since full IANA picker is out of scope */}
                  <FormField
                    control={form.control}
                    name="timezone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Default timezone</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="e.g. America/New_York, UTC, Europe/London"
                          />
                        </FormControl>
                        <FormDescription className="text-xs text-[var(--color-muted-foreground)]">
                          IANA timezone name used for date display and scheduled tasks.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Date format (PA-009) */}
                  <FormField
                    control={form.control}
                    name="dateFormat"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Date format</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select date format" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {DATE_FORMAT_OPTIONS.map((fmt) => (
                              <SelectItem key={fmt} value={fmt}>
                                {fmt}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/* Default pagination size (PA-009) */}
                  <FormField
                    control={form.control}
                    name="defaultPageSize"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Default page size</FormLabel>
                        <Select
                          onValueChange={(v) => field.onChange(Number(v))}
                          value={String(field.value)}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select page size" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {PAGINATION_OPTIONS.map((size) => (
                              <SelectItem key={size} value={String(size)}>
                                {size} per page
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormDescription className="text-xs text-[var(--color-muted-foreground)]">
                          Default number of items shown per page across the platform.
                        </FormDescription>
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
        </section>

        {/* Danger zone */}
        <section aria-labelledby="danger-zone-heading">
          <div className="rounded-lg border border-[var(--color-destructive)]/30 p-4 space-y-4">
            <h2 id="danger-zone-heading" className="text-sm font-semibold text-[var(--color-destructive)]">Danger zone</h2>

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
        </section>
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
