/**
 * Tests for the OpenAPI spec builder.
 *
 * These tests verify the structural correctness of the generated spec,
 * the enforcement of .describe() naming, and the handling of edge cases
 * like discriminated unions and standard error responses.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { buildSpec, type OpenApiDocument } from "../spec-builder.js";
import { requireDescribedName } from "../zod-converter.js";
import type { ServiceOpenApiMeta } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const simpleLoginRequest = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .describe("SimpleLoginRequest");

const simpleLoginResponse = z
  .object({
    data: z.object({
      accessToken: z.string(),
      expiresIn: z.number(),
    }),
  })
  .describe("SimpleLoginResponse");

const simpleMeta: ServiceOpenApiMeta = {
  info: {
    title: "Test Service",
    description: "A test service.",
    version: "1.0.0",
  },
  tags: [{ name: "Auth", description: "Authentication routes" }],
  routes: [
    {
      method: "POST",
      path: "/api/v1/auth/login",
      summary: "Login",
      tags: ["Auth"],
      security: [],
      body: { schema: simpleLoginRequest, contentType: "application/json" },
      response: { 200: simpleLoginResponse },
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildSpec", () => {
  it("produces openapi: 3.0.3 (not 3.1.0)", () => {
    const spec = buildSpec(simpleMeta);
    expect(spec.openapi).toBe("3.0.3");
  });

  it("includes info block from meta", () => {
    const spec = buildSpec(simpleMeta);
    expect(spec.info.title).toBe("Test Service");
    expect(spec.info.version).toBe("1.0.0");
  });

  it("registers path from route", () => {
    const spec = buildSpec(simpleMeta);
    expect(spec.paths["/api/v1/auth/login"]).toBeDefined();
    expect(spec.paths["/api/v1/auth/login"]?.["post"]).toBeDefined();
  });

  it("places request body schema in components/schemas", () => {
    const spec = buildSpec(simpleMeta);
    expect(spec.components.schemas["SimpleLoginRequest"]).toBeDefined();
    const bodyRef = (
      (spec.paths["/api/v1/auth/login"]?.["post"] as Record<string, unknown>)?.[
        "requestBody"
      ] as Record<string, unknown> | undefined
    )?.["content"];
    const ref = (
      (bodyRef as Record<string, unknown> | undefined)?.["application/json"] as
        | Record<string, unknown>
        | undefined
    )?.["schema"];
    expect(ref).toEqual({ $ref: "#/components/schemas/SimpleLoginRequest" });
  });

  it("places response schema in components/schemas", () => {
    const spec = buildSpec(simpleMeta);
    expect(spec.components.schemas["SimpleLoginResponse"]).toBeDefined();
    const operation = spec.paths["/api/v1/auth/login"]?.["post"] as
      | Record<string, unknown>
      | undefined;
    const responseEntry = (operation?.["responses"] as Record<string, unknown>)?.[
      "200"
    ] as Record<string, unknown> | undefined;
    const schema = (
      (responseEntry?.["content"] as Record<string, unknown> | undefined)?.[
        "application/json"
      ] as Record<string, unknown> | undefined
    )?.["schema"];
    expect(schema).toEqual({ $ref: "#/components/schemas/SimpleLoginResponse" });
  });

  it("always includes standard error responses (400, 401, 403, 404, 429, 500)", () => {
    const spec = buildSpec(simpleMeta);
    const operation = spec.paths["/api/v1/auth/login"]?.["post"] as
      | Record<string, unknown>
      | undefined;
    const responses = operation?.["responses"] as Record<string, unknown> | undefined;
    for (const code of ["400", "401", "403", "404", "429", "500"]) {
      expect(responses?.[code]).toBeDefined();
    }
  });

  it("uses security: [] for public routes", () => {
    const spec = buildSpec(simpleMeta);
    const operation = spec.paths["/api/v1/auth/login"]?.["post"] as
      | Record<string, unknown>
      | undefined;
    expect(operation?.["security"]).toEqual([]);
  });

  it("defaults to BearerAuth security for routes without explicit security", () => {
    const responseSchema = z
      .object({ id: z.string() })
      .describe("ProtectedRouteResponse");
    const meta: ServiceOpenApiMeta = {
      info: { title: "T", description: "T", version: "1.0.0" },
      tags: [],
      routes: [
        {
          method: "GET",
          path: "/api/v1/protected",
          summary: "Protected",
          tags: [],
          // security omitted → should default to BearerAuth
          response: { 200: responseSchema },
        },
      ],
    };
    const spec = buildSpec(meta);
    const operation = spec.paths["/api/v1/protected"]?.["get"] as
      | Record<string, unknown>
      | undefined;
    expect(operation?.["security"]).toEqual([{ BearerAuth: [] }]);
  });

  it("includes BearerAuth and ApiKeyAuth security schemes in components", () => {
    const spec = buildSpec(simpleMeta);
    expect(spec.components.securitySchemes["BearerAuth"]).toBeDefined();
    expect(spec.components.securitySchemes["ApiKeyAuth"]).toBeDefined();
  });

  it("derives operationId from method + path", () => {
    const spec = buildSpec(simpleMeta);
    const operation = spec.paths["/api/v1/auth/login"]?.["post"] as
      | Record<string, unknown>
      | undefined;
    expect(operation?.["operationId"]).toBe("postApiV1AuthLogin");
  });

  it("includes query parameters flattened from a Zod object schema", () => {
    const querySchema = z.object({
      cursor: z.string().optional(),
      limit: z.number().optional(),
    });
    const responseSchema = z.object({ data: z.array(z.string()) }).describe("ListResponse");
    const meta: ServiceOpenApiMeta = {
      info: { title: "T", description: "T", version: "1.0.0" },
      tags: [],
      routes: [
        {
          method: "GET",
          path: "/api/v1/items",
          summary: "List items",
          tags: [],
          query: { schema: querySchema },
          response: { 200: responseSchema },
        },
      ],
    };
    const spec = buildSpec(meta);
    const operation = spec.paths["/api/v1/items"]?.["get"] as
      | Record<string, unknown>
      | undefined;
    const params = operation?.["parameters"] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(params).toBeDefined();
    const names = params?.map((p) => p["name"]);
    expect(names).toContain("cursor");
    expect(names).toContain("limit");
  });

  it("includes path parameters from params entry", () => {
    const responseSchema = z.object({ id: z.string() }).describe("ItemResponse");
    const meta: ServiceOpenApiMeta = {
      info: { title: "T", description: "T", version: "1.0.0" },
      tags: [],
      routes: [
        {
          method: "GET",
          path: "/api/v1/items/:id",
          summary: "Get item",
          tags: [],
          params: { id: z.string().uuid() },
          response: { 200: responseSchema },
        },
      ],
    };
    const spec = buildSpec(meta);
    const operation = spec.paths["/api/v1/items/:id"]?.["get"] as
      | Record<string, unknown>
      | undefined;
    const params = operation?.["parameters"] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(params).toBeDefined();
    const idParam = params?.find((p) => p["name"] === "id");
    expect(idParam?.["in"]).toBe("path");
    expect(idParam?.["required"]).toBe(true);
  });

  it("handles z.discriminatedUnion and produces a valid discriminator structure", () => {
    const successSchema = z
      .object({ status: z.literal("ok"), data: z.string() })
      .describe("DiscUnionSuccess");
    const errorSchema = z
      .object({ status: z.literal("error"), reason: z.string() })
      .describe("DiscUnionError");
    const unionSchema = z
      .discriminatedUnion("status", [successSchema, errorSchema])
      .describe("DiscUnionResult");

    const meta: ServiceOpenApiMeta = {
      info: { title: "T", description: "T", version: "1.0.0" },
      tags: [],
      routes: [
        {
          method: "GET",
          path: "/api/v1/union",
          summary: "Union test",
          tags: [],
          response: { 200: unionSchema },
        },
      ],
    };

    // Should not throw — zod-to-json-schema handles discriminatedUnion
    const spec = buildSpec(meta);
    expect(spec.components.schemas["DiscUnionResult"]).toBeDefined();
    // The generated schema should be an object-level definition, not empty
    const schema = spec.components.schemas["DiscUnionResult"] as Record<string, unknown>;
    // zod-to-json-schema maps discriminatedUnion to anyOf in openApi3 target mode.
    // Each variant has the discriminant field's enum value in its properties.
    expect(schema["anyOf"]).toBeDefined();
    const variants = schema["anyOf"] as Array<Record<string, unknown>>;
    expect(variants).toHaveLength(2);
  });

  it("marks route as deprecated when deprecated: true", () => {
    const respSchema = z.object({ ok: z.boolean() }).describe("DeprecatedResp");
    const meta: ServiceOpenApiMeta = {
      info: { title: "T", description: "T", version: "1.0.0" },
      tags: [],
      routes: [
        {
          method: "GET",
          path: "/api/v1/old",
          summary: "Old endpoint",
          tags: [],
          deprecated: true,
          deprecationMessage: "Use /api/v1/new instead.",
          response: { 200: respSchema },
        },
      ],
    };
    const spec = buildSpec(meta);
    const operation = spec.paths["/api/v1/old"]?.["get"] as
      | Record<string, unknown>
      | undefined;
    expect(operation?.["deprecated"]).toBe(true);
    expect((operation?.["description"] as string | undefined)?.includes("DEPRECATED")).toBe(true);
  });

  it("throws when z.lazy() is used in a response schema", () => {
    const lazySchema = z.lazy(() => z.string()).describe("LazySchema");
    const meta: ServiceOpenApiMeta = {
      info: { title: "T", description: "T", version: "1.0.0" },
      tags: [],
      routes: [
        {
          method: "GET",
          path: "/api/v1/lazy",
          summary: "Lazy schema",
          tags: [],
          response: { 200: lazySchema },
        },
      ],
    };
    expect(() => buildSpec(meta)).toThrow("z.lazy()");
  });
});

describe("requireDescribedName", () => {
  it("returns the description when .describe() was called", () => {
    const schema = z.string().describe("MySchemaName");
    expect(requireDescribedName(schema)).toBe("MySchemaName");
  });

  it("strips whitespace from the description", () => {
    const schema = z.string().describe("My Schema Name");
    expect(requireDescribedName(schema)).toBe("MySchemaName");
  });

  it("throws when .describe() was not called", () => {
    const schema = z.string();
    expect(() => requireDescribedName(schema)).toThrow(
      "Schema has no .describe() name",
    );
  });

  it("throws for a plain z.object() without .describe()", () => {
    const schema = z.object({ id: z.string() });
    expect(() => requireDescribedName(schema)).toThrow();
  });
});
