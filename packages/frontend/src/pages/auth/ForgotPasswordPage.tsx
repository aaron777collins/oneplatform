/**
 * ForgotPasswordPage — email input for password reset requests.
 *
 * POST /api/v1/auth/forgot-password with the email address. The server
 * always responds with 200 regardless of whether the email exists (prevents
 * user enumeration). The UI shows a success state after submission.
 */
import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link } from "@tanstack/react-router";
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

const forgotPasswordSchema = z.object({
  email: z.string().email("Enter a valid email address"),
});

type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ForgotPasswordPage() {
  const client = useApiClient();
  const [submitted, setSubmitted] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const form = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  async function handleSubmit(values: ForgotPasswordValues): Promise<void> {
    setServerError(null);
    try {
      await client.post("/v1/auth/forgot-password", { email: values.email });
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setServerError(err.message);
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
            <CardTitle className="text-lg">Reset your password</CardTitle>
            <CardDescription>
              Enter your email and we'll send reset instructions.
            </CardDescription>
          </CardHeader>

          <CardContent>
            {submitted ? (
              <div className="flex flex-col items-center gap-4 py-4 text-center">
                <CheckCircle2
                  className="h-10 w-10 text-[var(--color-primary)]"
                  aria-hidden="true"
                />
                <p className="text-sm text-[var(--color-foreground)]">
                  If that email is registered, you'll receive reset instructions
                  shortly. Check your inbox.
                </p>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/login">Back to sign-in</Link>
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
                      ? "Sending…"
                      : "Send reset link"}
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
