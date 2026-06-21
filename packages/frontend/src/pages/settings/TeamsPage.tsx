/**
 * TeamsPage — team/user management: invite users, list members, role assignment.
 *
 * Route: /settings/teams
 *
 * The invite form POSTs to /v1/users — the same endpoint that creates users
 * in the auth service. Role selection is a simple dropdown (PA-001).
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Trash2, UserPlus } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { Badge } from "@/components/ui/badge.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { useApiClient, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { PaginatedResponse } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// Types & schema
// ---------------------------------------------------------------------------

interface Member {
  id: string;
  email: string;
  displayName?: string;
  roles: string[];
  createdAt: string;
}

const ALL_ROLES = ["viewer", "editor", "developer", "tenant-admin", "admin"] as const;
type Role = (typeof ALL_ROLES)[number];

const ROLE_LABELS: Record<Role, string> = {
  viewer: "Viewer",
  editor: "Editor",
  developer: "Developer",
  "tenant-admin": "Tenant Admin",
  admin: "Admin",
};

const inviteSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  role: z.enum(ALL_ROLES),
});
type InviteValues = z.infer<typeof inviteSchema>;

// Labels shown next to role badges in the member table
const ROLE_BADGE_VARIANT: Record<Role, "default" | "secondary" | "outline"> = {
  viewer:          "outline",
  editor:          "secondary",
  developer:       "secondary",
  "tenant-admin":  "default",
  admin:           "default",
};

// ---------------------------------------------------------------------------
// TeamsPage component
// ---------------------------------------------------------------------------

// Pending role change — captured before the confirmation dialog is shown
interface PendingRoleChange {
  member: Member;
  newRoles: string[];
  addedRole: Role | null;
  removedRole: Role | null;
}

export function TeamsPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const [removeTarget, setRemoveTarget] = React.useState<Member | null>(null);
  // Role change confirmation: we capture the intended change and only apply it
  // after the user confirms, preventing accidental permission changes from misclicks.
  const [pendingRoleChange, setPendingRoleChange] =
    React.useState<PendingRoleChange | null>(null);

  // Use /v1/users for member list since /v1/teams/* endpoints are not implemented
  const membersQuery = useQuery({
    queryKey: ["users", "members"],
    queryFn: ({ signal }) =>
      client.get<PaginatedResponse<Member>>("/v1/users", undefined, { signal }),
  });

  const members = membersQuery.data?.data ?? [];

  const inviteForm = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "viewer" },
  });

  const inviteMutation = useMutation({
    // POST to /v1/users — creates a pending invitation that the auth service
    // resolves when the invited user completes sign-up (PA-001)
    mutationFn: (values: InviteValues) =>
      client.post("/v1/users", { email: values.email, roles: [values.role], sendInvite: true }),
    onSuccess: () => {
      toast({ title: "Invitation sent", description: "The user will receive an email to join." });
      inviteForm.reset();
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Failed to send invite.";
      toast({ title: "Invite failed", description: message, variant: "destructive" });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ memberId, roles }: { memberId: string; roles: string[] }) =>
      client.put(`/v1/users/${memberId}`, { roles }),
    onSuccess: () => {
      toast({ title: "Role updated" });
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Role update failed.";
      toast({ title: "Role update failed", description: message, variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) =>
      client.put(`/v1/users/${memberId}`, { isActive: false }),
    onSuccess: () => {
      toast({ title: "Member deactivated" });
      setRemoveTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Deactivation failed.";
      toast({ title: "Deactivation failed", description: message, variant: "destructive" });
    },
  });

  return (
    <div>
      <PageHeader title="Teams" description="Manage members and their access roles." />

      {/* Invite form (PA-001) */}
      <div className="mb-8 mt-6 max-w-lg rounded-lg border border-[var(--color-border)] p-6">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          Invite a team member
        </h2>
        <Form {...inviteForm}>
          <form
            onSubmit={(e) => void inviteForm.handleSubmit((v) => inviteMutation.mutate(v))(e)}
            className="space-y-4"
          >
            <FormField
              control={inviteForm.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email address</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="colleague@company.com"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={inviteForm.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Role</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a role" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ALL_ROLES.map((role) => (
                        <SelectItem key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              disabled={inviteMutation.isPending}
              aria-busy={inviteMutation.isPending}
            >
              {inviteMutation.isPending ? "Sending..." : "Send invite"}
            </Button>
          </form>
        </Form>
      </div>

      {/* Members table */}
      <h2 className="mb-3 text-sm font-semibold">Members</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Roles</TableHead>
            <TableHead>Joined</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {membersQuery.isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <TableRow key={i}>
                {Array.from({ length: 4 }).map((__, j) => (
                  <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                ))}
              </TableRow>
            ))
          ) : members.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="py-8 text-center text-sm text-[var(--color-muted-foreground)]">
                No members yet. Send an invitation above to add someone.
              </TableCell>
            </TableRow>
          ) : (
            members.map((member) => (
              <TableRow key={member.id}>
                <TableCell>
                  <p className="text-sm font-medium">{member.displayName ?? member.email}</p>
                  {member.displayName !== undefined && (
                    <p className="text-xs text-[var(--color-muted-foreground)]">{member.email}</p>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {/* Active roles as static badges; click a toggle button to change */}
                    {member.roles.map((role) => (
                      <Badge
                        key={role}
                        variant={ROLE_BADGE_VARIANT[role as Role] ?? "outline"}
                        className="text-[10px]"
                      >
                        {ROLE_LABELS[role as Role] ?? role}
                      </Badge>
                    ))}
                    {/* Toggle buttons for quick role changes — clicking opens a confirmation
                        dialog before any change is applied to prevent accidental misclicks. */}
                    <div className="mt-1 flex flex-wrap gap-1 border-t border-[var(--color-border)]/50 pt-1 w-full">
                      {ALL_ROLES.map((role) => {
                        const active = member.roles.includes(role);
                        return (
                          <button
                            key={role}
                            type="button"
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors border ${
                              active
                                ? "bg-[var(--color-primary,#6366f1)] text-white border-[var(--color-primary,#6366f1)]"
                                : "bg-transparent text-[var(--color-muted-foreground,#6b7280)] border-[var(--color-border,#e5e7eb)] hover:border-[var(--color-primary,#6366f1)]/50"
                            }`}
                            onClick={() => {
                              const next = active
                                ? member.roles.filter((r) => r !== role)
                                : [...member.roles, role];
                              // Prevent removing the last role — every user needs at least one
                              if (next.length === 0) return;
                              setPendingRoleChange({
                                member,
                                newRoles: next,
                                addedRole: active ? null : role,
                                removedRole: active ? role : null,
                              });
                            }}
                            aria-pressed={active}
                            aria-label={`${active ? "Remove" : "Add"} ${ROLE_LABELS[role]} role`}
                          >
                            {ROLE_LABELS[role]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-sm">
                  <RelativeTime value={member.createdAt} />
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-[var(--color-destructive)]"
                    onClick={() => setRemoveTarget(member)}
                    aria-label={`Deactivate ${member.email}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
        title="Deactivate member"
        description={`Deactivate ${removeTarget?.email ?? "this member"}? They will lose access immediately.`}
        confirmLabel="Deactivate"
        onConfirm={() => {
          if (removeTarget !== null) removeMutation.mutate(removeTarget.id);
        }}
        isLoading={removeMutation.isPending}
      />

      {/* Role change confirmation — prevents accidental permission changes from misclicks */}
      <ConfirmDialog
        open={pendingRoleChange !== null}
        onOpenChange={(open) => { if (!open) setPendingRoleChange(null); }}
        title="Change role?"
        description={
          pendingRoleChange !== null
            ? pendingRoleChange.addedRole !== null
              ? `Add the ${ROLE_LABELS[pendingRoleChange.addedRole]} role to ${pendingRoleChange.member.displayName ?? pendingRoleChange.member.email}?`
              : pendingRoleChange.removedRole !== null
              ? `Remove the ${ROLE_LABELS[pendingRoleChange.removedRole]} role from ${pendingRoleChange.member.displayName ?? pendingRoleChange.member.email}?`
              : "Apply this role change?"
            : "Apply this role change?"
        }
        confirmLabel="Confirm"
        onConfirm={() => {
          if (pendingRoleChange !== null) {
            updateRoleMutation.mutate({
              memberId: pendingRoleChange.member.id,
              roles: pendingRoleChange.newRoles,
            });
            setPendingRoleChange(null);
          }
        }}
        isLoading={updateRoleMutation.isPending}
      />
    </div>
  );
}
