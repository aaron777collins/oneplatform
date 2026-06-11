/**
 * AdminAccountStep — step 1 of the setup wizard.
 *
 * Collects the initial admin email, password, and confirm password. On "Next"
 * the values are stored in the wizard Zustand store so the Review step can
 * display them and the POST /api/v1/auth/bootstrap can include them.
 *
 * Password strength rules (§9.2): min 12 chars, mixed case, number.
 */
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useWizardStore } from "@/stores/wizard.store.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { WizardStep } from "@/components/wizard/WizardStep.js";
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

const adminAccountSchema = z
  .object({
    adminEmail: z.string().email("Enter a valid email address"),
    adminPassword: z
      .string()
      .min(12, "Password must be at least 12 characters")
      .regex(/[A-Z]/, "Password must contain an uppercase letter")
      .regex(/[a-z]/, "Password must contain a lowercase letter")
      .regex(/[0-9]/, "Password must contain a number"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.adminPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type AdminAccountFormValues = z.infer<typeof adminAccountSchema>;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AdminAccountStepProps {
  onNext: () => void;
  onPrev: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AdminAccountStep({ onNext, onPrev }: AdminAccountStepProps) {
  const updateField = useWizardStore((state) => state.updateField);
  const storedEmail = useWizardStore((state) => state.adminEmail);
  const storedPassword = useWizardStore((state) => state.adminPassword);

  const form = useForm<AdminAccountFormValues>({
    resolver: zodResolver(adminAccountSchema),
    defaultValues: {
      adminEmail: storedEmail,
      adminPassword: storedPassword,
      confirmPassword: storedPassword,
    },
  });

  function handleSubmit(values: AdminAccountFormValues): void {
    updateField("adminEmail", values.adminEmail);
    updateField("adminPassword", values.adminPassword);
    onNext();
  }

  return (
    <WizardStep
      title="Admin account"
      description="This account will have full platform-admin access."
    >
      <Form {...form}>
        <form
          onSubmit={(e) => void form.handleSubmit(handleSubmit)(e)}
          noValidate
          className="space-y-4"
        >
          <FormField
            control={form.control}
            name="adminEmail"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    autoComplete="email"
                    placeholder="admin@example.com"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="adminPassword"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
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
                <FormLabel>Confirm password</FormLabel>
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

          <div className="flex gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onPrev} className="flex-1">
              Back
            </Button>
            <Button type="submit" className="flex-1">
              Next
            </Button>
          </div>
        </form>
      </Form>
    </WizardStep>
  );
}
