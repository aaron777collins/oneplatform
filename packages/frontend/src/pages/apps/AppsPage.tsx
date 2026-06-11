/**
 * AppsPage — grid of app cards with search and access mode filter.
 *
 * Route: /apps
 *
 * Provides a "New App" button that opens a name/slug creation dialog.
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Search, LayoutGrid } from "lucide-react";

// Cast Lucide icons to avoid exactOptionalPropertyTypes conflict on className
type IconComponent = React.ComponentType<{ className?: string }>;
const LayoutGridIcon = LayoutGrid as IconComponent;
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { AppCard, type AppCardData, type AppAccessMode } from "@/components/apps/AppCard.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { PaginatedResponse } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// New app form schema
// ---------------------------------------------------------------------------

const newAppSchema = z.object({
  name: z.string().min(1, "Name is required").max(64),
  slug: z
    .string()
    .min(1, "Slug is required")
    .max(48)
    .regex(/^[a-z0-9-]+$/, "Slug may only contain lowercase letters, numbers, and hyphens"),
  accessMode: z.enum(["public", "platform-user"]),
});

type NewAppValues = z.infer<typeof newAppSchema>;

// ---------------------------------------------------------------------------
// AppsPage component
// ---------------------------------------------------------------------------

export function AppsPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [search, setSearch] = React.useState("");
  const [accessFilter, setAccessFilter] = React.useState<AppAccessMode | "all">("all");
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const query = useQuery({
    queryKey: ["apps"],
    queryFn: ({ signal }) =>
      client.get<PaginatedResponse<AppCardData>>("/v1/apps", undefined, { signal }),
  });

  const apps = query.data?.data ?? [];

  const filtered = React.useMemo(() => {
    const lower = search.toLowerCase();
    return apps.filter((app) => {
      if (accessFilter !== "all" && app.accessMode !== accessFilter) return false;
      if (lower !== "" && !app.name.toLowerCase().includes(lower) && !app.slug.includes(lower)) return false;
      return true;
    });
  }, [apps, search, accessFilter]);

  const form = useForm<NewAppValues>({
    resolver: zodResolver(newAppSchema),
    defaultValues: { name: "", slug: "", accessMode: "platform-user" },
  });

  // Auto-generate slug from name
  const nameValue = form.watch("name");
  React.useEffect(() => {
    const slug = nameValue
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    form.setValue("slug", slug, { shouldValidate: false });
  }, [nameValue, form]);

  const createMutation = useMutation({
    mutationFn: (values: NewAppValues) =>
      client.post<{ data: AppCardData }>("/v1/apps", values),
    onSuccess: (response) => {
      toast({ title: "App created" });
      void queryClient.invalidateQueries({ queryKey: ["apps"] });
      setDialogOpen(false);
      form.reset();
      void navigate({ to: "/apps/$id", params: { id: response.data.id } });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Failed to create app.";
      toast({ title: "Create failed", description: message, variant: "destructive" });
    },
  });

  return (
    <div className="flex-1 p-6">
      <PageHeader
        title="Apps"
        description="Monaco-built internal tools and data views."
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            New App
          </Button>
        }
      />

      {/* Filters */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 max-w-sm">
          <Search
            className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
            aria-hidden="true"
          />
          <Input
            placeholder="Search apps…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
            aria-label="Search apps"
          />
        </div>

        <div className="flex gap-1" role="group" aria-label="Filter by access mode">
          {(["all", "public", "platform-user"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setAccessFilter(mode)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                accessFilter === mode
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                  : "border-[var(--color-border)] hover:bg-[var(--color-muted)]"
              }`}
              aria-pressed={accessFilter === mode}
            >
              {mode === "all" ? "All" : mode === "public" ? "Public" : "Platform users"}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {query.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={LayoutGridIcon}
          title={apps.length === 0 ? "No apps yet" : "No apps match your filters"}
          {...(apps.length === 0 ? {
            description: "Create your first app to get started.",
            actionLabel: "New App",
            onAction: () => setDialogOpen(true),
          } : {})}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              onClick={(id) => void navigate({ to: "/apps/$id", params: { id } })}
              onEdit={(id) => void navigate({ to: "/apps/$id/edit", params: { id } })}
            />
          ))}
        </div>
      )}

      {/* New app dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New App</DialogTitle>
            <DialogDescription>
              Create a new Monaco-powered app. You can edit the code immediately after creation.
            </DialogDescription>
          </DialogHeader>
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
                    <FormLabel>App name <span className="text-[var(--color-destructive)]" aria-hidden>*</span></FormLabel>
                    <FormControl>
                      <Input placeholder="My Internal Tool" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>URL slug <span className="text-[var(--color-destructive)]" aria-hidden>*</span></FormLabel>
                    <FormControl>
                      <Input placeholder="my-internal-tool" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="accessMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Access mode</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="platform-user">Platform users only</SelectItem>
                        <SelectItem value="public">Public (no auth required)</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button variant="outline" type="button" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createMutation.isPending} aria-busy={createMutation.isPending}>
                  {createMutation.isPending ? "Creating…" : "Create app"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
