/**
 * TeamsPage — team/user management: invite users, list members, role assignment.
 *
 * Route: /settings/teams
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { UserPlus, Trash2 } from "lucide-react";
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
  role: string;
  joinedAt: string;
}

const inviteSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  role: z.enum(["viewer", "editor", "admin"]),
});
type InviteValues = z.infer<typeof inviteSchema>;

// ---------------------------------------------------------------------------
// TeamsPage component
// ---------------------------------------------------------------------------

export function TeamsPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const [removeTarget, setRemoveTarget] = React.useState<Member | null>(null);

  const membersQuery = useQuery({
    queryKey: ["teams", "members"],
    queryFn: ({ signal }) =>
      client.get<PaginatedResponse<Member>>("/v1/teams/members", undefined, { signal }),
  });

  const members = membersQuery.data?.data ?? [];

  const form = useForm<InviteValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "viewer" },
  });

  const inviteMutation = useMutation({
    mutationFn: (values: InviteValues) =>
      client.post("/v1/teams/invites", values),
    onSuccess: () => {
      toast({ title: "Invitation sent" });
      form.reset();
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Invite failed.";
      toast({ title: "Invite failed", description: message, variant: "destructive" });
    },
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: string }) =>
      client.patch(`/v1/teams/members/${memberId}`, { role }),
    onSuccess: () => {
      toast({ title: "Role updated" });
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Role update failed.";
      toast({ title: "Role update failed", description: message, variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) =>
      client.delete(`/v1/teams/members/${memberId}`),
    onSuccess: () => {
      toast({ title: "Member removed" });
      setRemoveTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : "Remove failed.";
      toast({ title: "Remove failed", description: message, variant: "destructive" });
    },
  });

  return (
    <main id="main-content" tabIndex={-1} className="flex-1 p-6">
      <PageHeader title="Teams" description="Manage members and their access roles." />

      {/* Invite form */}
      <div className="mb-8 mt-6 max-w-lg rounded-lg border border-[var(--color-border)] p-4">
        <h2 className="mb-4 text-sm font-semibold">Invite member</h2>
        <Form {...form}>
          <form
            onSubmit={(e) => void form.handleSubmit((v) => inviteMutation.mutate(v))(e)}
            className="flex items-end gap-3"
          >
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormLabel>Email address</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="colleague@example.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem className="w-32">
                  <FormLabel>Role</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="viewer">Viewer</SelectItem>
                      <SelectItem value="editor">Editor</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
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
              className="mb-0"
            >
              <UserPlus className="mr-2 h-4 w-4" aria-hidden="true" />
              {inviteMutation.isPending ? "Inviting…" : "Invite"}
            </Button>
          </form>
        </Form>
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
                  <Select
                    value={member.role}
                    onValueChange={(role) => updateRoleMutation.mutate({ memberId: member.id, role })}
                  >
                    <SelectTrigger className="w-28 h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="viewer">Viewer</SelectItem>
                      <SelectItem value="editor">Editor</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-sm">
                  <RelativeTime value={member.joinedAt} />
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-[var(--color-destructive)]"
                    onClick={() => setRemoveTarget(member)}
                    aria-label={`Remove ${member.email}`}
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
        title="Remove member"
        description={`Remove ${removeTarget?.email ?? "this member"} from the team? They will lose access immediately.`}
        confirmLabel="Remove"
        onConfirm={() => {
          if (removeTarget !== null) removeMutation.mutate(removeTarget.id);
        }}
        isLoading={removeMutation.isPending}
      />
    </main>
  );
}
