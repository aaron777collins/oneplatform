/**
 * ProfilePage — user profile settings: display name, email, password change.
 *
 * Route: /settings/profile
 */
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useMutation } from "@tanstack/react-query";
import { PageHeader } from "@/components/layout/PageHeader.js";
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
import { useSession } from "@/hooks/use-auth.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const profileSchema = z.object({
  displayName: z.string().min(1, "Display name is required").max(64),
  email: z.string().email("Enter a valid email address"),
});

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(12, "Password must be at least 12 characters"),
    confirmPassword: z.string().min(1, "Please confirm your new password"),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type ProfileValues = z.infer<typeof profileSchema>;
type PasswordValues = z.infer<typeof passwordSchema>;

// ---------------------------------------------------------------------------
// ProfilePage component
// ---------------------------------------------------------------------------

// Shape returned by the auth/me endpoint
interface MeResponse {
  data: {
    displayName: string;
    email: string;
  };
}

export function ProfilePage() {
  const { userId } = useSession();
  const client = useApiClient();

  const profileForm = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { displayName: "", email: "" },
  });

  const passwordForm = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  // Fetch current user data and pre-populate the profile form so users see
  // their existing values rather than blank fields on first load.
  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: ({ signal }) => client.get<MeResponse>("/v1/auth/me", undefined, { signal }),
  });

  React.useEffect(() => {
    if (meQuery.data) {
      profileForm.reset({
        displayName: meQuery.data.data.displayName,
        email: meQuery.data.data.email,
      });
    }
  }, [meQuery.data, profileForm]);

  const updateProfileMutation = useMutation({
    mutationFn: (values: ProfileValues) =>
      client.patch(`/v1/auth/users/${userId}`, values),
    onSuccess: () => {
      toast({ title: "Profile updated" });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Update failed.";
      toast({ title: "Update failed", description: message, variant: "destructive" });
    },
  });

  const changePasswordMutation = useMutation({
    mutationFn: (values: PasswordValues) =>
      client.post("/v1/auth/change-password", {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      }),
    onSuccess: () => {
      toast({ title: "Password changed" });
      passwordForm.reset();
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Password change failed.";
      toast({ title: "Password change failed", description: message, variant: "destructive" });
    },
  });

  return (
    <div>
      <PageHeader title="Profile" description="Manage your personal account details." />

      <div className="mt-6 max-w-lg space-y-6">
        {/* Profile info */}
        <div className="rounded-lg border border-[var(--color-border)] p-4">
          <h2 className="mb-4 text-sm font-semibold">Account information</h2>
          <Form {...profileForm}>
            <form
              onSubmit={(e) => void profileForm.handleSubmit((v) => updateProfileMutation.mutate(v))(e)}
              className="space-y-4"
            >
              <FormField
                control={profileForm.control}
                name="displayName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Display name</FormLabel>
                    <FormControl><Input {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={profileForm.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email address</FormLabel>
                    <FormControl>
                      <Input type="email" autoComplete="email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                disabled={updateProfileMutation.isPending}
                aria-busy={updateProfileMutation.isPending}
              >
                {updateProfileMutation.isPending ? "Saving…" : "Save changes"}
              </Button>
            </form>
          </Form>
        </div>

        {/* Password change */}
        <div className="rounded-lg border border-[var(--color-border)] p-4">
          <h2 className="mb-4 text-sm font-semibold">Change password</h2>
          <Form {...passwordForm}>
            <form
              onSubmit={(e) => void passwordForm.handleSubmit((v) => changePasswordMutation.mutate(v))(e)}
              className="space-y-4"
            >
              <FormField
                control={passwordForm.control}
                name="currentPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current password</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="current-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={passwordForm.control}
                name="newPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>New password</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={passwordForm.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Confirm new password</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                variant="outline"
                disabled={changePasswordMutation.isPending}
                aria-busy={changePasswordMutation.isPending}
              >
                {changePasswordMutation.isPending ? "Changing…" : "Change password"}
              </Button>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
