/**
 * OrgNameStep — step 2 of the setup wizard.
 *
 * Collects the tenant/organization name. Validates length (2–64 chars per
 * §9.2, "2–64 chars, no leading/trailing spaces") and stores in wizard store.
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
  FormDescription,
} from "@/components/ui/form.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const orgNameSchema = z.object({
  orgName: z
    .string()
    .min(1, "Organization name is required")
    .max(100, "Organization name must be at most 100 characters")
    .refine((v) => v.trim().length >= 2, "Organization name must be at least 2 characters")
    .refine((v) => v === v.trim(), "Organization name must not have leading or trailing spaces"),
});

type OrgNameFormValues = z.infer<typeof orgNameSchema>;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface OrgNameStepProps {
  onNext: () => void;
  onPrev: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OrgNameStep({ onNext, onPrev }: OrgNameStepProps) {
  const updateField = useWizardStore((state) => state.updateField);
  const storedOrgName = useWizardStore((state) => state.orgName);

  const form = useForm<OrgNameFormValues>({
    resolver: zodResolver(orgNameSchema),
    defaultValues: { orgName: storedOrgName },
  });

  function handleSubmit(values: OrgNameFormValues): void {
    updateField("orgName", values.orgName);
    onNext();
  }

  return (
    <WizardStep
      title="Organization name"
      description="The name of your company or team. This appears throughout the platform."
    >
      <Form {...form}>
        <form
          onSubmit={(e) => void form.handleSubmit(handleSubmit)(e)}
          noValidate
          className="space-y-4"
        >
          <FormField
            control={form.control}
            name="orgName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Organization name</FormLabel>
                <FormControl>
                  <Input
                    type="text"
                    autoComplete="organization"
                    placeholder="Acme Corp"
                    maxLength={100}
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  2–100 characters. No leading or trailing spaces.
                </FormDescription>
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
