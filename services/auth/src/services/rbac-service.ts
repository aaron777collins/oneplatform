// Role-based and ontology-aware entity/field/row permission checking.
// Implements the RBAC model from L2 design §8.
//
// hasScope / hasRole are synchronous because they operate on the JWT claims
// that are already in memory. Entity/field/row checks hit the DB because
// auth.entity_permissions is tenant-specific and not JWT-encoded.
//
// Field restriction semantics (L2 design §8.3):
//   - A field is visible if ANY role allows it (least-restrictive wins)
//   - A field is denied only if ALL matching roles deny it
//
// Row filter semantics:
//   - Multiple roles' row filters are ANDed
//   - platform-admin and tenant-admin have no row filters applied

import type pg from "pg";
import type { UserContext } from "@oneplatform/core";
import type { FieldRestrictions, RowFilter } from "./types.js";

// ---------------------------------------------------------------------------
// Entity permission DB row
// ---------------------------------------------------------------------------

interface EntityPermissionRow {
  role: string;
  actions: string[];
  field_restrictions: {
    deny_read?: string[];
    deny_write?: string[];
  };
  row_filter: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Roles that bypass all row filters (L2 design §8.3)
// ---------------------------------------------------------------------------

const PRIVILEGED_ROLES = new Set(["platform-admin", "tenant-admin"]);

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface RbacServiceDeps {
  db: pg.Pool;
}

export interface RbacService {
  hasScope(user: UserContext, scope: string): boolean;
  hasRole(user: UserContext, role: string): boolean;
  canAccessEntity(
    user: UserContext,
    entityType: string,
    action: string
  ): Promise<boolean>;
  getFieldRestrictions(
    user: UserContext,
    entityType: string
  ): Promise<FieldRestrictions>;
  getRowFilter(user: UserContext, entityType: string): Promise<RowFilter>;
}

export function createRbacService(deps: RbacServiceDeps): RbacService {
  const { db } = deps;

  // -------------------------------------------------------------------------
  // Synchronous scope check (operates on JWT claims in memory)
  // -------------------------------------------------------------------------

  function hasScope(user: UserContext, scope: string): boolean {
    // 'admin' scope encompasses all other scopes
    if (user.scopes.includes("admin")) return true;
    return user.scopes.includes(scope);
  }

  // -------------------------------------------------------------------------
  // Synchronous role check
  // -------------------------------------------------------------------------

  function hasRole(user: UserContext, role: string): boolean {
    return user.roles.includes(role);
  }

  // -------------------------------------------------------------------------
  // Entity-level access check
  // -------------------------------------------------------------------------

  async function canAccessEntity(
    user: UserContext,
    entityType: string,
    action: string
  ): Promise<boolean> {
    // platform-admin and tenant-admin have unrestricted entity access
    if (user.roles.some((r) => PRIVILEGED_ROLES.has(r))) {
      return true;
    }

    const rows = await fetchEntityPermissions(
      user.tenantId,
      entityType,
      user.roles
    );

    if (rows.length === 0) return false;

    // Permission is granted if ANY matching role allows the action
    return rows.some(
      (row) =>
        row.actions.includes(action) ||
        row.actions.includes("admin")
    );
  }

  // -------------------------------------------------------------------------
  // Field restrictions
  // -------------------------------------------------------------------------

  async function getFieldRestrictions(
    user: UserContext,
    entityType: string
  ): Promise<FieldRestrictions> {
    // Privileged roles have no field restrictions
    if (user.roles.some((r) => PRIVILEGED_ROLES.has(r))) {
      return { denyRead: [], denyWrite: [] };
    }

    const rows = await fetchEntityPermissions(
      user.tenantId,
      entityType,
      user.roles
    );

    if (rows.length === 0) {
      return { denyRead: [], denyWrite: [] };
    }

    // Collect all deny sets per role, then intersect:
    // A field is denied if ALL matching roles deny it.
    // A field is allowed if ANY role allows it.
    const allDenyRead = rows.map(
      (r) => new Set<string>(r.field_restrictions.deny_read ?? [])
    );
    const allDenyWrite = rows.map(
      (r) => new Set<string>(r.field_restrictions.deny_write ?? [])
    );

    return {
      denyRead: intersectSets(allDenyRead),
      denyWrite: intersectSets(allDenyWrite),
    };
  }

  // -------------------------------------------------------------------------
  // Row filter
  // -------------------------------------------------------------------------

  async function getRowFilter(
    user: UserContext,
    entityType: string
  ): Promise<RowFilter> {
    // Privileged roles have no row filters
    if (user.roles.some((r) => PRIVILEGED_ROLES.has(r))) {
      return { conditions: {} };
    }

    const rows = await fetchEntityPermissions(
      user.tenantId,
      entityType,
      user.roles
    );

    if (rows.length === 0) {
      return { conditions: {} };
    }

    // AND all row filters together: merge all condition maps
    const merged: Record<string, string> = {};
    for (const row of rows) {
      for (const [field, value] of Object.entries(row.row_filter)) {
        // If multiple roles specify the same field, keep the first (most
        // restrictive first wins — roles are ordered by user.roles array).
        if (!(field in merged)) {
          merged[field] = value;
        }
      }
    }

    return { conditions: merged };
  }

  // -------------------------------------------------------------------------
  // DB helpers
  // -------------------------------------------------------------------------

  async function fetchEntityPermissions(
    tenantId: string,
    entityType: string,
    roles: string[]
  ): Promise<EntityPermissionRow[]> {
    if (roles.length === 0) return [];

    // Fetch permissions for all of the user's roles for this entity type.
    // Also includes wildcard entity_type = '*' rows.
    const result = await db.query<EntityPermissionRow>(
      `SELECT role, actions, field_restrictions, row_filter
       FROM auth.entity_permissions
       WHERE tenant_id = $1
         AND entity_type = ANY($2::text[])
         AND role = ANY($3::text[])`,
      [tenantId, [entityType, "*"], roles]
    );

    return result.rows;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Returns the intersection of all sets.
   * A field is in the intersection only if it appears in EVERY set.
   * Empty input → empty intersection (no restrictions).
   */
  function intersectSets(sets: Set<string>[]): string[] {
    if (sets.length === 0) return [];

    // Start with the first set and retain only elements present in all others
    const first = sets[0];
    if (!first) return [];

    const intersection = new Set<string>(first);
    for (let i = 1; i < sets.length; i++) {
      const set = sets[i];
      if (!set) continue;
      for (const item of intersection) {
        if (!set.has(item)) {
          intersection.delete(item);
        }
      }
    }
    return Array.from(intersection);
  }

  // -------------------------------------------------------------------------

  return {
    hasScope,
    hasRole,
    canAccessEntity,
    getFieldRestrictions,
    getRowFilter,
  };
}
