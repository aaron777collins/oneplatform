// SCIM 2.0 scaffold — RFC 7644 user provisioning endpoints.
//
// This module provides the minimal SCIM 2.0 surface required for Identity
// Provider (IdP) integration (e.g. Okta, Azure AD, OneLogin). IdPs use SCIM
// to provision, update, and deprovision users automatically, eliminating
// manual user management in the admin UI.
//
// Implemented endpoints:
//   GET    /api/v1/scim/Users        — list users (paginated, filterable)
//   POST   /api/v1/scim/Users        — create a user from a SCIM payload
//   GET    /api/v1/scim/Users/:id    — get a single user
//   PATCH  /api/v1/scim/Users/:id    — update user fields or active status
//   DELETE /api/v1/scim/Users/:id    — deactivate (soft-delete) a user
//
// Scope requirement: all SCIM endpoints require the `users:manage` scope.
// The caller must be a machine token or admin-level IdP integration account
// — SCIM is not intended for end-user consumption.
//
// SCIM 2.0 field mappings (RFC 7643 §8.7.1):
//   SCIM userName      ↔ internal email
//   SCIM name.formatted ↔ internal display_name
//   SCIM emails[0].value ↔ internal email
//   SCIM active        ↔ internal is_active
//   SCIM id            ↔ internal id
//   SCIM externalId    ↔ stored in metadata.scimExternalId (future use)
//
// The schema URI for User resources is:
//   urn:ietf:params:scim:schemas:core:2.0:User

import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from "@oneplatform/core";
import type { UserRepository } from "../repositories/index.js";
import type { User } from "../repositories/index.js";

// ---------------------------------------------------------------------------
// SCIM schema URN constants
// ---------------------------------------------------------------------------

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_LIST_RESPONSE_SCHEMA =
  "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

// ---------------------------------------------------------------------------
// SCIM type definitions (minimal subset for user provisioning)
// ---------------------------------------------------------------------------

interface ScimEmail {
  value: string;
  type?: string;
  primary?: boolean;
}

interface ScimName {
  formatted?: string;
  givenName?: string;
  familyName?: string;
}

// Inbound SCIM User payload (POST / PATCH body from the IdP)
interface ScimUserBody {
  schemas?: string[];
  userName?: string;
  name?: ScimName;
  displayName?: string;
  emails?: ScimEmail[];
  active?: boolean;
  externalId?: string;
  // PATCH operations are wrapped in Operations[]
  Operations?: Array<{
    op: "add" | "replace" | "remove";
    path?: string;
    value?: unknown;
  }>;
}

// ---------------------------------------------------------------------------
// Mapper: internal User → SCIM User resource
// ---------------------------------------------------------------------------

function toScimUser(user: User): Record<string, unknown> {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    externalId: (user.metadata as Record<string, unknown>)?.["scimExternalId"] ?? null,
    userName: user.email,
    name: {
      formatted: user.display_name ?? user.email,
    },
    displayName: user.display_name ?? user.email,
    emails: [
      {
        value: user.email,
        type: "work",
        primary: true,
      },
    ],
    active: user.is_active,
    meta: {
      resourceType: "User",
      created: user.created_at.toISOString(),
      lastModified: (user.updated_at as Date | undefined)?.toISOString() ?? user.created_at.toISOString(),
      location: `/api/v1/scim/Users/${user.id}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Mapper: SCIM User body → fields understood by UserRepository
// ---------------------------------------------------------------------------

function scimBodyToCreateData(
  body: ScimUserBody,
  tenantId: string,
): {
  tenant_id: string;
  email: string;
  display_name: string;
  roles: string[];
  email_verified: boolean;
  metadata?: Record<string, unknown>;
} {
  // userName is the primary identity field in SCIM; fall back to emails[0]
  const email =
    body.userName?.toLowerCase() ??
    body.emails?.find((e) => e.primary)?.value.toLowerCase() ??
    body.emails?.[0]?.value.toLowerCase();

  if (!email) {
    throw new ValidationError(
      "SCIM User payload must include userName or a primary email address."
    );
  }

  const nameParts = [body.name?.givenName, body.name?.familyName]
    .filter(Boolean)
    .join(" ");
  const displayName =
    body.displayName ??
    body.name?.formatted ??
    (nameParts.length > 0 ? nameParts : email);

  const metadata: Record<string, unknown> = {};
  if (body.externalId !== undefined) {
    metadata["scimExternalId"] = body.externalId;
  }

  return {
    tenant_id: tenantId,
    email,
    display_name: displayName,
    // SCIM provisioned users are assigned the viewer role by default.
    // The IdP or an admin can reassign roles via a subsequent PATCH.
    roles: ["viewer"],
    // SCIM-provisioned users are considered email-verified — the IdP has
    // already authenticated them within its own directory.
    email_verified: true,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

// ---------------------------------------------------------------------------
// Route deps
// ---------------------------------------------------------------------------

export interface ScimRouteDeps {
  userRepository: UserRepository;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createScimRoutes(
  deps: ScimRouteDeps,
): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { userRepository } = deps;

  // Shared scope guard — all SCIM endpoints require users:manage or admin.
  // The `user` variable is always present on authenticated routes; the auth
  // middleware populates it before any route handler runs.
  function assertScimScope(user: AppVariables["user"]): void {
    if (!user.scopes.includes("users:manage") && !user.scopes.includes("admin")) {
      throw new ForbiddenError(
        "SCIM endpoints require the users:manage scope. " +
          "Configure an admin service account for your IdP integration."
      );
    }
  }

  // ---------------------------------------------------------------------------
  // GET /api/v1/scim/Users — list users (SCIM ListResponse)
  //
  // Supports the SCIM startIndex + count pagination model (1-based index).
  // Also accepts the filter parameter for basic attribute-based filtering
  // (e.g. filter=userName eq "alice@example.com") — only the eq operator
  // on userName is implemented in this scaffold; full SCIM filter grammar
  // is deferred to a follow-up when the IdP integration matures.
  // ---------------------------------------------------------------------------

  routes.get("/api/v1/scim/Users", async (c) => {
    assertScimScope(c.var.user);
    const tenantId = c.var.user.tenantId;

    // SCIM pagination uses 1-based startIndex + count (not cursor-based).
    // We translate to our cursor-based repository by fetching from the start
    // when startIndex is 1, and falling through to offset emulation otherwise.
    const startIndex = Math.max(1, parseInt(c.req.query("startIndex") ?? "1", 10) || 1);
    const count = Math.min(
      Math.max(1, parseInt(c.req.query("count") ?? "50", 10) || 50),
      200, // Hard cap matching UserRepository.MAX_LIMIT
    );

    // Basic filter support: filter=userName eq "value"
    let emailFilter: string | undefined;
    const filterParam = c.req.query("filter");
    if (filterParam !== undefined) {
      const match = /^userName\s+eq\s+"([^"]+)"/i.exec(filterParam.trim());
      if (match?.[1] !== undefined) {
        emailFilter = match[1];
      }
    }

    // Fetch one extra item so we can compute totalResults without a separate
    // COUNT query for the common case where the entire set fits in one page.
    const { users } = await userRepository.listByTenant(
      tenantId,
      undefined,
      count + (startIndex - 1), // offset emulation for small startIndex values
      { ...(emailFilter !== undefined ? { email: emailFilter } : {}) },
    );

    const totalResults = await userRepository.countByTenant(tenantId, {
      ...(emailFilter !== undefined ? { email: emailFilter } : {}),
    });

    // Apply the startIndex offset (1-based, so index 1 = first item)
    const pageUsers = users.slice(startIndex - 1, startIndex - 1 + count);

    return c.json({
      schemas: [SCIM_LIST_RESPONSE_SCHEMA],
      totalResults,
      startIndex,
      itemsPerPage: pageUsers.length,
      Resources: pageUsers.map(toScimUser),
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/scim/Users — provision a new user from SCIM payload
  // ---------------------------------------------------------------------------

  routes.post("/api/v1/scim/Users", async (c) => {
    assertScimScope(c.var.user);
    const tenantId = c.var.user.tenantId;

    const body = await c.req.json() as ScimUserBody;

    // Validate that the schema field contains the expected SCIM User schema URI
    // when provided — some IdPs include it, others omit it.
    if (
      body.schemas !== undefined &&
      body.schemas.length > 0 &&
      !body.schemas.includes(SCIM_USER_SCHEMA)
    ) {
      return c.json(
        {
          schemas: [SCIM_ERROR_SCHEMA],
          status: "400",
          detail:
            `Unsupported schema. Expected "${SCIM_USER_SCHEMA}" in the schemas array.`,
        },
        400,
      );
    }

    const createData = scimBodyToCreateData(body, tenantId);

    // Guard: reject duplicate email within the tenant.
    const existing = await userRepository.findByEmail(tenantId, createData.email);
    if (existing !== null) {
      // SCIM spec (RFC 7644 §3.3) requires HTTP 409 for uniqueness conflicts.
      return c.json(
        {
          schemas: [SCIM_ERROR_SCHEMA],
          status: "409",
          scimType: "uniqueness",
          detail: `A user with userName "${createData.email}" already exists in this tenant.`,
        },
        409,
      );
    }

    const created = await userRepository.create(createData);
    return c.json(toScimUser(created), 201);
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/scim/Users/:id — retrieve a single user by OnePlatform ID
  // ---------------------------------------------------------------------------

  routes.get("/api/v1/scim/Users/:id", async (c) => {
    assertScimScope(c.var.user);
    const id = c.req.param("id");
    const tenantId = c.var.user.tenantId;

    const user = await userRepository.findById(id);
    // Tenant mismatch is hidden as NotFound to prevent cross-tenant enumeration.
    if (user === null || user.tenant_id !== tenantId) {
      throw new NotFoundError(`SCIM User ${id} not found.`);
    }

    return c.json(toScimUser(user));
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/v1/scim/Users/:id — update user via SCIM PatchOp (RFC 7644 §3.5.2)
  //
  // IdPs send partial updates as a list of Operations. The most common ones are:
  //   { op: "replace", path: "active", value: false }  — deactivate user
  //   { op: "replace", value: { displayName: "..." } } — update display name
  //   { op: "replace", value: { emails: [...] } }      — update primary email
  //
  // We implement the most common operations used by major IdPs. The full SCIM
  // PatchOp grammar is not implemented in this scaffold version.
  // ---------------------------------------------------------------------------

  routes.patch("/api/v1/scim/Users/:id", async (c) => {
    assertScimScope(c.var.user);
    const id = c.req.param("id");
    const tenantId = c.var.user.tenantId;

    const existing = await userRepository.findById(id);
    if (existing === null || existing.tenant_id !== tenantId) {
      throw new NotFoundError(`SCIM User ${id} not found.`);
    }

    const body = await c.req.json() as ScimUserBody;
    const operations = body.Operations ?? [];

    if (operations.length === 0) {
      // No-op: return the current state unchanged (idempotent).
      return c.json(toScimUser(existing));
    }

    let newDisplayName: string | undefined;
    let newActive: boolean | undefined;

    for (const op of operations) {
      if (op.op !== "add" && op.op !== "replace" && op.op !== "remove") {
        // Skip unknown operations — be liberal in what we accept.
        continue;
      }

      const path = op.path?.toLowerCase();
      const value = op.value;

      if (path === "active") {
        newActive = Boolean(value);
      } else if (path === "displayname") {
        newDisplayName = String(value ?? "");
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        // No path — value is a partial User object
        const partial = value as Record<string, unknown>;
        if (typeof partial["active"] === "boolean") {
          newActive = partial["active"];
        }
        if (typeof partial["displayName"] === "string") {
          newDisplayName = partial["displayName"];
        }
        // Note: email/userName changes via SCIM PATCH are not supported in this
        // scaffold version. Email is the primary identity key in OnePlatform;
        // changing it requires a separate email-change-verification flow that
        // SCIM does not natively model. IdPs should deprovision + re-provision
        // to change a user's email address.
      }
    }

    // Apply field updates
    let updated = existing;

    if (newDisplayName !== undefined) {
      updated = await userRepository.update(id, { display_name: newDisplayName });
    }

    // Apply activation status changes
    if (newActive === true) {
      await userRepository.activate(id);
    } else if (newActive === false) {
      await userRepository.deactivate(id);
    }

    // Reflect the updated active state in the response even when we did not
    // re-fetch after the activate/deactivate call (avoiding an extra round-trip).
    const responseUser: User = {
      ...updated,
      is_active: newActive !== undefined ? newActive : updated.is_active,
    };

    return c.json(toScimUser(responseUser));
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/v1/scim/Users/:id — deprovision (deactivate) a user
  //
  // SCIM DELETE does not permanently remove data — it deactivates the account.
  // Hard deletion of PII is handled by the GDPR erasure flow (separate endpoint).
  // This matches the behaviour expected by IdPs: they call DELETE when a user
  // is removed from the IdP directory, expecting the user to lose access, not
  // to have their data erased.
  // ---------------------------------------------------------------------------

  routes.delete("/api/v1/scim/Users/:id", async (c) => {
    assertScimScope(c.var.user);
    const id = c.req.param("id");
    const tenantId = c.var.user.tenantId;

    const existing = await userRepository.findById(id);
    if (existing === null || existing.tenant_id !== tenantId) {
      throw new NotFoundError(`SCIM User ${id} not found.`);
    }

    await userRepository.deactivate(id);

    // RFC 7644 §3.6: successful DELETE returns HTTP 204 with no body.
    return new Response(null, { status: 204 });
  });

  return routes;
}
