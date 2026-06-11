/**
 * ResetPasswordPage — new password form submitted with a reset token.
 *
 * The token is extracted from the URL by TanStack Router (/reset-password/$token)
 * and included in the POST /api/v1/auth/reset-password body. On success the
 * user is redirected to /login.
 */
import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Loader2, CheckCircle2 } from "lucide-react";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card.js";
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

const resetPasswordSchema = z
  .object({
    password: z
      .string()
      .min(12, "Password must be at least 12 characters")
      .regex(/[A-Z]/, "Password must contain an uppercase letter")
      .regex(/[a-z]/, "Password must contain a lowercase letter")
      .regex(/[0-9]/, "Password must contain a number"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ResetPasswordPage() {
  const { token } = useParams({ from: "/reset-password/$token" });
  const client = useApiClient();
  const navigate = useNavigate();
  const [succeeded, setSucceeded] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  async function handleSubmit(values: ResetPasswordValues): Promise<void> {
    setServerError(null);
    try {
      await client.post("/v1/auth/reset-password", {
        token,
        password: values.password,
      });
      setSucceeded(true);
      // Auto-redirect after 3 seconds so the user sees the success message
      setTimeout(() => {
        void navigate({ to: "/login" });
      }, 3000);
    } catch (err) {
      if (err instanceof ApiError) {
        // 410 Gone means the token was already used or has expired
        if (err.statusCode === 410 || err.statusCode === 404) {
          setServerError(
            "This reset link has expired or already been used. Request a new one.",
          );
        } else {
          setServerError(err.message);
        }
      } else {
        setServerError("An unexpected error occurred. Please try again.");
      }
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-background)] px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-[var(--color-foreground)]">
            OnePlatform
          </h1>
        </div>

        <Card>
          <CardHeader className="space-y-1">
            <CardTitle className="text-lg">Set new password</CardTitle>
            <CardDescription>
              Choose a strong password for your account.
            </CardDescription>
          </CardHeader>

          <CardContent>
            {succeeded ? (
              <div className="flex flex-col items-center gap-4 py-4 text-center">
                <CheckCircle2
                  className="h-10 w-10 text-[var(--color-primary)]"
                  aria-hidden="true"
                />
                <p className="text-sm text-[var(--color-foreground)]">
                  Password updated. Redirecting to sign-in…
                </p>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/login">Sign in now</Link>
                </Button>
              </div>
            ) : (
              <Form {...form}>
                <form
                  onSubmit={(e) => void form.handleSubmit(handleSubmit)(e)}
                  noValidate
                  className="space-y-4"
                >
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
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>New password</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            autoComplete="new-password"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="confirmPassword"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Confirm new password</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            autoComplete="new-password"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <Button
                    type="submit"
                    className="w-full"
                    disabled={form.formState.isSubmitting}
                  >
                    {form.formState.isSubmitting && (
                      <Loader2
                        className="mr-2 h-4 w-4 animate-spin"
                        aria-hidden="true"
                      />
                    )}
                    {form.formState.isSubmitting
                      ? "Updating…"
                      : "Update password"}
                  </Button>

                  <div className="text-center">
                    <Link
                      to="/login"
                      className="text-sm text-[var(--color-primary)] hover:underline"
                    >
                      Back to sign-in
                    </Link>
                  </div>
                </form>
              </Form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
