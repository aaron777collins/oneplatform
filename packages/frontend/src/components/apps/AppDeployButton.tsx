/**
 * AppDeployButton — triggers a new build/deploy via POST /api/v1/apps/:id/builds.
 *
 * Shows a spinner during the in-flight request and fires a toast on completion.
 * The button is disabled while any build mutation is pending to prevent double-submit.
 */
import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppBuild {
  id: string;
  appId: string;
  status: "queued" | "building" | "success" | "failed" | "cancelled";
  createdAt: string;
}

export interface AppDeployButtonProps extends Omit<ButtonProps, "onClick"> {
  appId: string;
  /** Called with the new build id after the POST succeeds */
  onBuildStarted?: (buildId: string) => void;
}

// ---------------------------------------------------------------------------
// AppDeployButton component
// ---------------------------------------------------------------------------

export function AppDeployButton({
  appId,
  onBuildStarted,
  className,
  children,
  ...props
}: AppDeployButtonProps) {
  const client = useApiClient();
  const queryClient = useQueryClient();

  const deployMutation = useMutation({
    mutationFn: () =>
      client.post<{ data: AppBuild }>(`/v1/apps/${appId}/builds`),
    onSuccess: (response) => {
      const build = response.data;
      toast({
        title: "Build started",
        description: `Build #${build.id.slice(0, 8)} queued.`,
      });
      // Invalidate builds list so it refreshes
      void queryClient.invalidateQueries({ queryKey: ["apps", appId, "builds"] });
      onBuildStarted?.(build.id);
    },
    onError: (error) => {
      const message =
        error instanceof ApiError ? error.message : "Failed to start build. Try again.";
      toast({ title: "Deploy failed", description: message, variant: "destructive" });
    },
  });

  const isPending = deployMutation.isPending;

  return (
    <Button
      className={cn(className)}
      disabled={isPending}
      aria-busy={isPending}
      onClick={() => deployMutation.mutate()}
      {...props}
    >
      {isPending ? (
        <span className="flex items-center gap-2">
          <span
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
          Deploying…
        </span>
      ) : (
        <span className="flex items-center gap-2">
          <Rocket className="h-4 w-4" aria-hidden="true" />
          {children ?? "Deploy"}
        </span>
      )}
    </Button>
  );
}
