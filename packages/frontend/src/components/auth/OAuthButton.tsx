/**
 * OAuthButton — SSO entry point for GitHub and Google.
 *
 * Clicking redirects the browser to the server-side OAuth authorize endpoint,
 * which issues the PKCE challenge and redirects to the provider. The browser
 * returns to /auth/callback after provider authorization. PKCE state is managed
 * server-side; this component is just a redirect trigger.
 */
import * as React from "react";
import { Github } from "lucide-react";
import { cn } from "@/lib/utils.js";
import { Button, type ButtonProps } from "@/components/ui/button.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OAuthProvider = "github" | "google";

export interface OAuthButtonProps extends Omit<ButtonProps, "onClick" | "children"> {
  provider: OAuthProvider;
}

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

const PROVIDER_CONFIG = {
  github: {
    label: "Sign in with GitHub",
    icon: GithubIcon,
  },
  google: {
    label: "Sign in with Google",
    icon: GoogleIcon,
  },
} as const satisfies Record<OAuthProvider, { label: string; icon: React.FC<{ className?: string }> }>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OAuthButton({ provider, className, ...props }: OAuthButtonProps) {
  const config = PROVIDER_CONFIG[provider];

  function initiateOAuth(): void {
    // Full-page redirect — server handles PKCE and returns to /auth/callback.
    window.location.href = `/api/v1/auth/oauth/${provider}/authorize`;
  }

  const Icon = config.icon;

  return (
    <Button
      type="button"
      variant="outline"
      className={cn("w-full gap-2", className)}
      onClick={initiateOAuth}
      {...props}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {config.label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Provider icons — inline SVGs to avoid extra HTTP requests
// ---------------------------------------------------------------------------

function GithubIcon({ className }: { className?: string }) {
  return <Github className={className} />;
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}
