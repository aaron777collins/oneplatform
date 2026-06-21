/**
 * ShareDialog — lets users control who can access a published app and copy
 * a shareable link to the clipboard.
 *
 * Access modes:
 *   private      — only the creator can see the app
 *   platform-user — any authenticated OnePlatform user
 *   public       — anyone with the link (no login required)
 *
 * The access-mode change is persisted immediately via PATCH /v1/apps/:id so
 * the link reflects the correct permission level when shared.
 */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, Lock, Users, Globe, Check, Copy, type LucideIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AccessMode = "private" | "platform-user" | "public";

export interface ShareDialogProps {
  appId: string;
  appSlug: string;
  currentAccessMode: AccessMode | string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface AccessOption {
  value: AccessMode;
  label: string;
  description: string;
  Icon: LucideIcon;
}

const ACCESS_OPTIONS: AccessOption[] = [
  {
    value: "private",
    label: "Private",
    description: "Only you can view this app.",
    Icon: Lock,
  },
  {
    value: "platform-user",
    label: "Team",
    description: "Any signed-in OnePlatform user can view this app.",
    Icon: Users,
  },
  {
    value: "public",
    label: "Public",
    description: "Anyone with the link can view this app — no login required.",
    Icon: Globe,
  },
];

// ---------------------------------------------------------------------------
// ShareDialog component
// ---------------------------------------------------------------------------

export function ShareDialog({
  appId,
  appSlug,
  currentAccessMode,
  open,
  onOpenChange,
}: ShareDialogProps) {
  const client = useApiClient();
  const queryClient = useQueryClient();

  // Track the selected mode locally so the UI is responsive even before the
  // PATCH completes. We reconcile with the server value on success/error.
  const [selectedMode, setSelectedMode] = React.useState<AccessMode>(
    normalizeAccessMode(currentAccessMode),
  );
  const [copied, setCopied] = React.useState(false);

  // Derive the full URL from the current page origin + app slug
  const shareableUrl = `${window.location.origin}/apps/${appSlug}`;

  // Sync local mode if the parent prop changes (e.g. settings tab update)
  React.useEffect(() => {
    setSelectedMode(normalizeAccessMode(currentAccessMode));
  }, [currentAccessMode]);

  const updateAccessMutation = useMutation({
    mutationFn: (accessMode: AccessMode) =>
      client.patch(`/v1/apps/${appId}`, { accessMode }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["apps", appId] });
      void queryClient.invalidateQueries({ queryKey: ["apps"] });
      toast({ title: "Access mode updated" });
    },
    onError: (error) => {
      // Roll back the optimistic local state to keep the UI consistent
      setSelectedMode(normalizeAccessMode(currentAccessMode));
      const message = error instanceof ApiError ? error.message : "Failed to update access mode.";
      toast({ title: "Update failed", description: message, variant: "destructive" });
    },
  });

  function handleAccessModeChange(mode: AccessMode) {
    if (mode === selectedMode) return;
    setSelectedMode(mode);
    updateAccessMutation.mutate(mode);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(shareableUrl);
      setCopied(true);
      // Reset icon after 2 s to confirm success without permanently cluttering the UI
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable in some environments (e.g. non-HTTPS)
      toast({
        title: "Could not copy",
        description: "Please copy the link manually.",
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="h-4 w-4" aria-hidden="true" />
            Share app
          </DialogTitle>
          <DialogDescription>
            Choose who can access this app and copy the shareable link.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Access mode selector */}
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--color-muted-foreground,#6b7280)]">
              Access
            </p>
            <div className="space-y-2" role="radiogroup" aria-label="App access mode">
              {ACCESS_OPTIONS.map(({ value, label, description, Icon }) => {
                const isSelected = selectedMode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => handleAccessModeChange(value)}
                    disabled={updateAccessMutation.isPending}
                    className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:cursor-wait ${
                      isSelected
                        ? "border-[var(--color-primary,#6366f1)] bg-[var(--color-primary,#6366f1)]/5"
                        : "border-[var(--color-border,#e5e7eb)] hover:bg-[var(--color-muted,#f3f4f6)]"
                    }`}
                  >
                    <Icon
                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                        isSelected
                          ? "text-[var(--color-primary,#6366f1)]"
                          : "text-[var(--color-muted-foreground,#6b7280)]"
                      }`}
                      aria-hidden="true"
                    />
                    <div className="flex-1 min-w-0">
                      <p
                        className={`text-sm font-medium ${
                          isSelected
                            ? "text-[var(--color-primary,#6366f1)]"
                            : "text-[var(--color-foreground,#111)]"
                        }`}
                      >
                        {label}
                      </p>
                      <p className="text-xs text-[var(--color-muted-foreground,#6b7280)]">
                        {description}
                      </p>
                    </div>
                    {isSelected && (
                      <Check
                        className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary,#6366f1)]"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Shareable link */}
          <div>
            <p className="mb-2 text-xs font-medium text-[var(--color-muted-foreground,#6b7280)]">
              Shareable link
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border,#e5e7eb)] bg-[var(--color-muted,#f3f4f6)] px-3 py-2">
              <span className="flex-1 truncate font-mono text-xs text-[var(--color-foreground,#111)]">
                {shareableUrl}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleCopy()}
                aria-label={copied ? "Link copied" : "Copy link to clipboard"}
                className="shrink-0 gap-1.5"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-600" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
            {selectedMode === "private" && (
              <p className="mt-1 text-[10px] text-[var(--color-muted-foreground,#6b7280)]">
                This app is private. Only you can open this link.
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coerce any string value to a valid AccessMode, defaulting to "private". */
function normalizeAccessMode(raw: string): AccessMode {
  if (raw === "public" || raw === "platform-user" || raw === "private") {
    return raw;
  }
  return "private";
}
