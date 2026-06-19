/**
 * PluginInstallDialog — dialog for installing a plugin from URL or file upload.
 *
 * Shows a manifest preview (name, type, version, author) before the user confirms.
 * Requires the plugins:manage scope per §10.2.
 */
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload, Globe } from "lucide-react";
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
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { PluginStatusBadge } from "./PluginStatusBadge.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PluginManifestPreview {
  name: string;
  type: string;
  version: string;
  author: string;
  description?: string;
}

const urlFormSchema = z.object({
  url: z.string().url("Enter a valid HTTPS URL"),
});

type UrlFormValues = z.infer<typeof urlFormSchema>;

export interface PluginInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstalled?: (pluginId: string) => void;
}

// ---------------------------------------------------------------------------
// PluginInstallDialog component
// ---------------------------------------------------------------------------

export function PluginInstallDialog({ open, onOpenChange, onInstalled }: PluginInstallDialogProps) {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const [tab, setTab] = React.useState<"url" | "upload">("url");
  const [manifest, setManifest] = React.useState<PluginManifestPreview | null>(null);
  const [pendingUrl, setPendingUrl] = React.useState<string | null>(null);

  const form = useForm<UrlFormValues>({
    resolver: zodResolver(urlFormSchema),
    defaultValues: { url: "" },
  });

  // Fetch manifest preview from URL before installing
  async function handlePreviewUrl(values: UrlFormValues) {
    try {
      const response = await client.get<{ data: PluginManifestPreview }>(
        "/v1/plugins/manifest-preview",
        { url: values.url },
      );
      setManifest(response.data);
      setPendingUrl(values.url);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "Could not fetch plugin manifest.";
      toast({ title: "Preview failed", description: message, variant: "destructive" });
    }
  }

  const installMutation = useMutation({
    mutationFn: (params: { url: string } | { file: File }) => {
      if ("url" in params) {
        return client.post<{ data: { id: string } }>("/v1/plugins", { sourceUrl: params.url });
      }
      // File upload via FormData
      const formData = new FormData();
      formData.append("bundle", params.file);
      return fetch("/api/v1/plugins", {
        method: "POST",
        credentials: "include",
        body: formData,
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
          throw new ApiError(res.status, "INSTALL_FAILED", body.error?.message ?? "Upload failed", "");
        }
        return res.json() as Promise<{ data: { id: string } }>;
      });
    },
    onSuccess: (response) => {
      toast({ title: "Plugin installed", description: manifest?.name ?? "Plugin added." });
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      onInstalled?.(response.data.id);
      handleClose();
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Installation failed.";
      toast({ title: "Install failed", description: message, variant: "destructive" });
    },
  });

  function handleClose() {
    onOpenChange(false);
    setManifest(null);
    setPendingUrl(null);
    form.reset();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file !== undefined) {
      installMutation.mutate({ file });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); else onOpenChange(true); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install Plugin</DialogTitle>
          <DialogDescription>
            Install a plugin from a URL or by uploading .oppkg plugin archives.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "url" | "upload")}>
          <TabsList className="w-full">
            <TabsTrigger value="url" className="flex-1">
              <Globe className="mr-2 h-4 w-4" aria-hidden="true" />
              From URL
            </TabsTrigger>
            <TabsTrigger value="upload" className="flex-1">
              <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
              Upload file
            </TabsTrigger>
          </TabsList>

          <TabsContent value="url" className="mt-4 space-y-4">
            <Form {...form}>
              <form onSubmit={(e) => void form.handleSubmit(handlePreviewUrl)(e)} className="space-y-3">
                <FormField
                  control={form.control}
                  name="url"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Plugin URL</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="https://plugins.example.com/my-plugin.oppkg"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button type="submit" variant="outline" size="sm">
                  Preview manifest
                </Button>
              </form>
            </Form>

            {/* Manifest preview */}
            {manifest !== null && (
              <div className="rounded-md border border-[var(--color-border)] p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="font-semibold">{manifest.name}</p>
                  <PluginStatusBadge status="installed" />
                </div>
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  {manifest.type} · v{manifest.version} · by {manifest.author}
                </p>
                {manifest.description !== undefined && (
                  <p className="text-sm">{manifest.description}</p>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="upload" className="mt-4">
            <label
              htmlFor="plugin-file-upload"
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-[var(--color-border)] p-8 text-center hover:border-[var(--color-primary)]/50 transition-colors"
            >
              <Upload className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden="true" />
              <p className="text-sm text-[var(--color-muted-foreground)]">
                Click to select or drag & drop a plugin archive
              </p>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                .oppkg or .tar.gz files
              </p>
              <input
                id="plugin-file-upload"
                type="file"
                accept=".oppkg,.tar.gz"
                className="sr-only"
                onChange={handleFileChange}
                aria-label="Upload plugin file"
              />
            </label>
            {installMutation.isPending && (
              <p className="mt-2 text-center text-sm text-[var(--color-muted-foreground)]">
                Uploading…
              </p>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          {tab === "url" && manifest !== null && (
            <Button
              onClick={() => {
                if (pendingUrl !== null) {
                  installMutation.mutate({ url: pendingUrl });
                }
              }}
              disabled={installMutation.isPending}
              aria-busy={installMutation.isPending}
            >
              {installMutation.isPending ? "Installing…" : "Install plugin"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
