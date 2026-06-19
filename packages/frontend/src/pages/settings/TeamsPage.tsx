/**
 * TeamsPage — team/user management: invite users, list members, role assignment.
 *
 * Route: /settings/teams
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Trash2, Info } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { Button } from "@/components/ui/button.js";
// Select components no longer used — roles now use toggle buttons for multi-role support
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
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

// ---------------------------------------------------------------------------
// TeamsPage component
// ---------------------------------------------------------------------------

export function TeamsPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const [removeTarget, setRemoveTarget] = React.useState<Member | null>(null);

  // Use /v1/users for member list since /v1/teams/* endpoints are not implemented
  const membersQuery = useQuery({
    queryKey: ["users", "members"],
    queryFn: ({ signal }) =>
      client.get<PaginatedResponse<Member>>("/v1/users", undefined, { signal }),
  });

  const members = membersQuery.data?.data ?? [];

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

      {/* Invite — Coming Soon placeholder */}
      <div className="mb-8 mt-6 max-w-lg rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/30 p-6">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold">Team invitations coming soon</h2>
            <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
              The ability to invite team members is under development. You can view existing members below.
            </p>
          </div>
        </div>
      </div>

      {/* Members table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Role</TableHead>
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
                No members yet.
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
                            // Ensure at least one role remains
                            if (next.length === 0) return;
                            updateRoleMutation.mutate({ memberId: member.id, roles: next });
                          }}
                          aria-pressed={active}
                          aria-label={`${active ? "Remove" : "Add"} ${ROLE_LABELS[role]} role`}
                        >
                          {ROLE_LABELS[role]}
                        </button>
                      );
                    })}
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
    </div>
  );
}
