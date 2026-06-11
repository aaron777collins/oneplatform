/**
 * LoginForm — email/password credentials form.
 *
 * Validation runs client-side via Zod before the POST fires. The server
 * is the authoritative validator; client-side validation only prevents
 * obviously malformed requests to reduce latency.
 *
 * On success the session is stored in the auth Zustand store and the caller
 * is responsible for navigation (so LoginPage controls the redirect target).
 */
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { useApiClient, ApiError } from "@/lib/api-client.js";
import { useAuthStore } from "@/stores/auth.store.js";
import type { Session } from "@/stores/auth.store.js";
import type { ApiResponse } from "@/lib/api-client.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LoginFormProps {
  /** Called on successful login so the parent page can redirect. */
  onSuccess: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LoginForm({ onSuccess }: LoginFormProps) {
  const client = useApiClient();
  const setSession = useAuthStore((state) => state.setSession);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const form = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function handleSubmit(values: LoginFormValues): Promise<void> {
    setServerError(null);
    try {
      const result = await client.post<ApiResponse<Session>>(
        "/v1/auth/login",
        { email: values.email, password: values.password },
      );
      setSession(result.data);
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        // 401 means wrong credentials — surface a friendly message instead of
        // redirecting (the redirect path is for expired sessions, not bad passwords).
        if (err.statusCode === 401) {
          setServerError("Invalid email or password.");
        } else {
          setServerError(err.message);
        }
      } else {
        setServerError("An unexpected error occurred. Please try again.");
      }
    }
  }

  const isSubmitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form
        onSubmit={(e) => void form.handleSubmit(handleSubmit)(e)}
        noValidate
        className="space-y-4"
      >
        {/* Server-level error — not tied to a specific field */}
        {serverError !== null && (
          <p
            role="alert"
            aria-live="assertive"
            className="rounded-md bg-[var(--color-destructive)]/10 px-4 py-3 text-sm text-[var(--color-destructive)]"
          >
            {serverError}
          </p>
        )}

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center justify-between">
                <FormLabel>Password</FormLabel>
                <Link
                  to="/forgot-password"
                  className="text-xs text-[var(--color-primary)] hover:underline"
                >
                  Forgot password?
                </Link>
              </div>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="current-password"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          )}
          {isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </Form>
  );
}
