/**
 * TemplatePickerDialog — shown when a user clicks "New App" on AppsPage.
 *
 * Step 1: pick a template (or "blank" to skip).
 * Step 2: fill in name / slug / access mode, then submit.
 *
 * Two separate POST endpoints are called depending on the selection:
 *   - Blank:    POST /v1/apps
 *   - Template: POST /v1/apps/from-template
 *
 * Both return { data: AppCardData } on 201.
 */
import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, BarChart2, ClipboardList, FilePlus, GitBranch, FileBarChart, PlugZap } from "lucide-react";
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
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/lib/utils.js";
import { useApiClient, ApiError, type ApiResponse } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { AppCardData } from "./AppCard.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TemplateCategory = "admin" | "dashboard" | "form" | "workflow" | "reporting" | "integration";

export interface TemplateMeta {
  id:                   string;
  name:                 string;
  description:          string;
  category:             TemplateCategory;
  thumbnail:            string;
  requiredPermissions:  string[];
}

// ---------------------------------------------------------------------------
// Icon mapping — keeps the component list lean without an icon-per-template API
// ---------------------------------------------------------------------------

type IconComponent = React.ComponentType<{ className?: string }>;

const CATEGORY_ICONS: Record<TemplateCategory, IconComponent> = {
  admin:       LayoutGrid as IconComponent,
  dashboard:   BarChart2 as IconComponent,
  form:        ClipboardList as IconComponent,
  workflow:    GitBranch as IconComponent,
  reporting:   FileBarChart as IconComponent,
  integration: PlugZap as IconComponent,
};

const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  admin: "Admin",
  dashboard: "Dashboard",
  form: "Forms",
  workflow: "Workflow",
  reporting: "Reporting",
  integration: "Integration",
};

// ---------------------------------------------------------------------------
// App creation form schema (shared for both blank and template creation)
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
// Dialog steps
// ---------------------------------------------------------------------------

type Step = "pick" | "configure";

// ---------------------------------------------------------------------------
// TemplatePickerDialog
// ---------------------------------------------------------------------------

export interface TemplatePickerDialogProps {
  open:      boolean;
  onOpenChange(open: boolean): void;
  onCreated(app: AppCardData): void;
}

export function TemplatePickerDialog({ open, onOpenChange, onCreated }: TemplatePickerDialogProps) {
  const client = useApiClient();

  const [step, setStep] = React.useState<Step>("pick");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [activeCategory, setActiveCategory] = React.useState<TemplateCategory | "all">("all");

  // Fetch templates from backend — only when dialog opens
  const templatesQuery = useQuery({
    queryKey: ["app-templates"],
    queryFn:  ({ signal }) =>
      client.get<ApiResponse<TemplateMeta[]>>("/v1/apps/templates", undefined, { signal }),
    enabled: open,
    staleTime: 5 * 60 * 1_000, // templates rarely change; cache for 5 min
  });

  const templates: TemplateMeta[] = templatesQuery.data?.data ?? [];

  // Reset to step 1 whenever the dialog is closed and re-opened
  React.useEffect(() => {
    if (!open) {
      setStep("pick");
      setSelectedId(null);
      setActiveCategory("all");
    }
  }, [open]);

  // Derive unique categories from templates
  const templateCategories = React.useMemo(() => {
    const cats = new Set(templates.map((t) => t.category));
    return Array.from(cats) as TemplateCategory[];
  }, [templates]);

  const filteredTemplates = activeCategory === "all"
    ? templates
    : templates.filter((t) => t.category === activeCategory);

  // Preview description for hovered/selected template
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const previewTemplate = templates.find((t) => t.id === (hoveredId ?? selectedId)) ?? null;

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

  // Mutation is invoked after the user fills in the configure step
  const createMutation = useMutation({
    mutationFn: (values: NewAppValues): Promise<{ data: AppCardData }> => {
      if (selectedId === null) {
        // Blank app
        return client.post<{ data: AppCardData }>("/v1/apps", values);
      }
      // Template app
      return client.post<{ data: AppCardData }>("/v1/apps/from-template", {
        ...values,
        templateId: selectedId,
      });
    },
    onSuccess: (response) => {
      toast({ title: "App created" });
      onOpenChange(false);
      form.reset();
      onCreated(response.data);
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Failed to create app.";
      toast({ title: "Create failed", description: message, variant: "destructive" });
    },
  });

  function handleTemplateSelect(id: string | null): void {
    setSelectedId(id);
    setStep("configure");
  }

  function handleBack(): void {
    setStep("pick");
    form.reset();
  }

  const selectedTemplate = templates.find((t) => t.id === selectedId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {step === "pick" ? (
          <>
            <DialogHeader>
              <DialogTitle>New App</DialogTitle>
              <DialogDescription>
                Choose a starter template or start from a blank app.
              </DialogDescription>
            </DialogHeader>

            {/* Category filter tabs */}
            {templateCategories.length > 1 && (
              <div className="flex flex-wrap gap-1.5 mt-2 mb-1">
                <button
                  type="button"
                  onClick={() => setActiveCategory("all")}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                    activeCategory === "all"
                      ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                      : "bg-[var(--color-muted)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)]",
                  )}
                >
                  All
                </button>
                {templateCategories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setActiveCategory(cat)}
                    className={cn(
                      "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                      activeCategory === cat
                        ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                        : "bg-[var(--color-muted)] text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)]",
                    )}
                  >
                    {CATEGORY_LABELS[cat] ?? cat}
                  </button>
                ))}
              </div>
            )}

            {/* Blank option always first */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 mt-2">
              <TemplateCard
                icon={FilePlus as IconComponent}
                name="Blank app"
                description="Start from the minimal default template."
                selected={false}
                onClick={() => handleTemplateSelect(null)}
                onMouseEnter={() => setHoveredId(null)}
                onMouseLeave={() => setHoveredId(null)}
              />

              {templatesQuery.isLoading
                ? Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-32 animate-pulse rounded-lg bg-[var(--color-muted)]" />
                  ))
                : filteredTemplates.map((t) => {
                    const Icon = CATEGORY_ICONS[t.category] ?? (FilePlus as IconComponent);
                    return (
                      <TemplateCard
                        key={t.id}
                        icon={Icon}
                        name={t.name}
                        description={t.description}
                        selected={selectedId === t.id}
                        onClick={() => handleTemplateSelect(t.id)}
                        onMouseEnter={() => setHoveredId(t.id)}
                        onMouseLeave={() => setHoveredId(null)}
                      />
                    );
                  })}
            </div>

            {/* Preview description area */}
            {previewTemplate !== null && (
              <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/30 p-3">
                <p className="text-xs font-semibold text-[var(--color-foreground)]">
                  {previewTemplate.name}
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted-foreground)] leading-relaxed">
                  {previewTemplate.description}
                </p>
                {previewTemplate.requiredPermissions.length > 0 && (
                  <p className="mt-1.5 text-[10px] text-[var(--color-muted-foreground)]">
                    Requires: {previewTemplate.requiredPermissions.join(", ")}
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {selectedTemplate !== null
                  ? `New app — ${selectedTemplate.name}`
                  : "New blank app"}
              </DialogTitle>
              <DialogDescription>
                Give your app a name and URL slug.
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
                      <FormLabel>
                        App name{" "}
                        <span className="text-[var(--color-destructive)]" aria-hidden>*</span>
                      </FormLabel>
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
                      <FormLabel>
                        URL slug{" "}
                        <span className="text-[var(--color-destructive)]" aria-hidden>*</span>
                      </FormLabel>
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
                  <Button
                    variant="outline"
                    type="button"
                    onClick={handleBack}
                    disabled={createMutation.isPending}
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    disabled={createMutation.isPending}
                    aria-busy={createMutation.isPending}
                  >
                    {createMutation.isPending ? "Creating…" : "Create app"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// TemplateCard — individual selectable card in the picker grid
// ---------------------------------------------------------------------------

interface TemplateCardProps {
  icon:        IconComponent;
  name:        string;
  description: string;
  selected:    boolean;
  onClick():   void;
  onMouseEnter?(): void;
  onMouseLeave?(): void;
}

function TemplateCard({ icon: Icon, name, description, selected, onClick, onMouseEnter, onMouseLeave }: TemplateCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={cn(
        "flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-all",
        "hover:border-[var(--color-primary)] hover:bg-[var(--color-muted)]",
        selected
          ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5 ring-1 ring-[var(--color-primary)]"
          : "border-[var(--color-border)]",
      )}
    >
      <Icon className="h-6 w-6 text-[var(--color-primary)] shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-sm font-semibold leading-snug">{name}</p>
        <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)] leading-relaxed line-clamp-2">
          {description}
        </p>
      </div>
    </button>
  );
}
