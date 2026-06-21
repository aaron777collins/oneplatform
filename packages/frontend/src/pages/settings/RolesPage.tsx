/**
 * RolesPage — read-only reference page for platform roles and their permissions.
 *
 * Route: /settings/roles
 *
 * Explains what each built-in role can do so operators and end-users have a
 * single place to understand the RBAC model without having to read documentation.
 * The page is deliberately read-only — role assignment is done via the Teams page.
 *
 * Role hierarchy (lowest → highest privilege):
 *   viewer < editor < admin < platform-admin
 */
import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader.js";

// ---------------------------------------------------------------------------
// Role data
// ---------------------------------------------------------------------------

interface RoleCapability {
  category: string;
  capabilities: string[];
}

interface RoleDefinition {
  id: string;
  label: string;
  description: string;
  capabilities: RoleCapability[];
}

const ROLES: RoleDefinition[] = [
  {
    id: "viewer",
    label: "Viewer",
    description: "Read-only access to approved platform resources.",
    capabilities: [
      {
        category: "Data",
        capabilities: ["View entities and data models", "Run read-only queries via Query Builder"],
      },
      {
        category: "Apps",
        capabilities: ["View published apps"],
      },
      {
        category: "Pipelines",
        capabilities: ["View pipeline runs and their status"],
      },
      {
        category: "Logs",
        capabilities: ["View platform logs"],
      },
    ],
  },
  {
    id: "editor",
    label: "Editor",
    description: "Create and modify platform resources but cannot manage users or platform settings.",
    capabilities: [
      {
        category: "Data",
        capabilities: [
          "All Viewer capabilities",
          "Create and edit entities and data models",
          "Import and export data",
        ],
      },
      {
        category: "Apps",
        capabilities: ["Create, edit, and publish apps", "Manage app templates"],
      },
      {
        category: "Pipelines",
        capabilities: ["Create, edit, and trigger pipelines", "View and reprocess DLQ events"],
      },
      {
        category: "Connectors",
        capabilities: ["Create and configure connectors", "Trigger manual sync"],
      },
      {
        category: "Plugins",
        capabilities: ["Install plugins from the marketplace"],
      },
    ],
  },
  {
    id: "admin",
    label: "Admin",
    description: "Full access within a tenant, including user and API key management.",
    capabilities: [
      {
        category: "All Editor capabilities",
        capabilities: [],
      },
      {
        category: "Users & Teams",
        capabilities: [
          "Invite and remove users",
          "Manage teams and team membership",
          "Assign roles (up to admin)",
        ],
      },
      {
        category: "API Keys",
        capabilities: ["Create, rotate, and revoke API keys"],
      },
      {
        category: "Webhooks",
        capabilities: ["Configure and test webhooks"],
      },
      {
        category: "Tenant Settings",
        capabilities: [
          "Edit tenant display name and preferences",
          "Configure timezone and date format",
        ],
      },
      {
        category: "Audit",
        capabilities: ["View the full audit log"],
      },
    ],
  },
  {
    id: "platform-admin",
    label: "Platform Admin",
    description: "Unrestricted access across all tenants. Reserved for system operators.",
    capabilities: [
      {
        category: "All Admin capabilities",
        capabilities: [],
      },
      {
        category: "Multi-tenant",
        capabilities: [
          "Create and delete tenants",
          "Impersonate users for support",
          "View cross-tenant system metrics",
        ],
      },
      {
        category: "System",
        capabilities: [
          "Access system health and metrics",
          "Rotate platform master key",
          "Manage platform-level plugins",
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// RoleBadge — colour-coded role badge
// ---------------------------------------------------------------------------

const ROLE_COLORS: Record<string, string> = {
  viewer: "bg-slate-100 text-slate-700 border-slate-200",
  editor: "bg-blue-50 text-blue-700 border-blue-200",
  admin: "bg-purple-50 text-purple-700 border-purple-200",
  "platform-admin": "bg-amber-50 text-amber-700 border-amber-200",
};

function RoleBadge({ roleId, label }: { roleId: string; label: string }) {
  const colorClass = ROLE_COLORS[roleId] ?? "bg-gray-100 text-gray-700 border-gray-200";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${colorClass}`}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// RoleCard — expandable card for a single role
// ---------------------------------------------------------------------------

function RoleCard({ role }: { role: RoleDefinition }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)]">
      {/* Header */}
      <div className="flex flex-col gap-1 border-b border-[var(--color-border)] p-4 sm:flex-row sm:items-center sm:gap-3">
        <RoleBadge roleId={role.id} label={role.label} />
        <p className="text-sm text-[var(--color-muted-foreground)]">{role.description}</p>
      </div>

      {/* Capabilities table */}
      <div className="divide-y divide-[var(--color-border)]">
        {role.capabilities.map((group) => (
          <div key={group.category} className="flex gap-4 p-3 text-sm">
            <span className="w-40 shrink-0 font-medium text-[var(--color-foreground)]">
              {group.category}
            </span>
            {group.capabilities.length === 0 ? (
              <span className="text-[var(--color-muted-foreground)] italic">
                (see above)
              </span>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {group.capabilities.map((cap) => (
                  <li key={cap} className="flex items-start gap-1.5 text-[var(--color-muted-foreground)]">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-primary)]" aria-hidden="true" />
                    {cap}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RolesPage component
// ---------------------------------------------------------------------------

export function RolesPage() {
  return (
    <div>
      <PageHeader
        title="Roles & Permissions"
        description="Reference guide for the built-in platform roles. Role assignment is managed on the Teams page."
      />

      <div className="mt-6 space-y-4 max-w-3xl">
        {/* Notice */}
        <div className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/40 p-3 text-sm">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
          <p className="text-[var(--color-muted-foreground)]">
            Roles are additive — each role includes all capabilities of the roles below it.
            Permissions are enforced server-side; the UI reflects what the server allows.
          </p>
        </div>

        {ROLES.map((role) => (
          <RoleCard key={role.id} role={role} />
        ))}
      </div>
    </div>
  );
}
