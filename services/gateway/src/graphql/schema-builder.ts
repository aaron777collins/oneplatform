// GraphQL schema generator.
//
// Converts the tenant's live ontology snapshot (EntityDefinition[]) into a
// GraphQLSchema that drives the parser validator and resolver factory.
//
// Design notes:
// - We generate one Object type + standard CRUD queries/mutations per entity.
// - The mapping is deterministic: same ontology → same SDL every time, so
//   callers can cache the schema alongside the OntologyCacheEntry.
// - No external graphql-js dependency — we represent the schema as plain
//   TypeScript maps that the hand-rolled parser and executor understand.

import type { EntityDefinition } from "../services/ontology-cache.js";
import type {
  GraphQLSchema,
  GraphQLObjectTypeDefinition,
  GraphQLFieldDefinition,
  GraphQLTypeDefinition,
  GraphQLFieldMapping,
  GraphQLArgDefinition,
  GraphQLTypeEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Field type mapping
// ---------------------------------------------------------------------------

// Maps each ontology fieldType to its canonical GraphQL scalar. We produce a
// generic Scalar name rather than a real GraphQL custom scalar — the executor
// serialises them as JSON strings, which is correct for date/json values.
const FIELD_TYPE_TO_GQL: Record<string, { gqlType: string; isList: boolean }> = {
  string:    { gqlType: "String",  isList: false },
  number:    { gqlType: "Float",   isList: false },
  boolean:   { gqlType: "Boolean", isList: false },
  date:      { gqlType: "String",  isList: false }, // ISO-8601 string
  json:      { gqlType: "JSON",    isList: false }, // serialised as String
  reference: { gqlType: "ID",      isList: false },
  enum:      { gqlType: "String",  isList: false }, // enum values passed as strings
  array:     { gqlType: "String",  isList: true  }, // array items coerced to String
};

// Pascal-cases a slug so "customer_order" becomes "CustomerOrder".
function toTypeName(slug: string): string {
  return slug
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

// Camel-cases a slug so "customer_order" becomes "customerOrder".
function toCamelCase(slug: string): string {
  const pascal = toTypeName(slug);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// Builds the plural camel-case query name: "customerOrder" → "customerOrders".
function toPluralQueryName(camel: string): string {
  if (camel.endsWith("y")) {
    return camel.slice(0, -1) + "ies";
  }
  if (camel.endsWith("s") || camel.endsWith("x") || camel.endsWith("z")) {
    return camel + "es";
  }
  return camel + "s";
}

// ---------------------------------------------------------------------------
// Built-in pagination / filter argument types
// ---------------------------------------------------------------------------

// Common pagination arguments generated for every list query.
const PAGINATION_ARGS: Record<string, GraphQLArgDefinition> = {
  after:  { type: "String",  nullable: true },
  first:  { type: "Int",     nullable: true },
  before: { type: "String",  nullable: true },
  last:   { type: "Int",     nullable: true },
};

// Per-entity filter input type fields are not modelled as separate Input types
// in this schema (that would require a full type system). Instead, list
// queries accept an opaque `filter` String argument carrying JSON-encoded
// FilterArg[], and a `sort` String argument carrying SortArg[]. This keeps
// the schema builder simple while still allowing field-level filtering.
const LIST_ARGS: Record<string, GraphQLArgDefinition> = {
  ...PAGINATION_ARGS,
  filter: { type: "String", nullable: true },
  sort:   { type: "String", nullable: true },
};

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface OntologyType {
  slug: string;
  name: string;
  fields: Array<{
    slug: string;
    fieldType: string;
    required: boolean;
    nullable: boolean;
  }>;
}

export function buildSchemaFromOntology(ontologyTypes: OntologyType[]): GraphQLSchema {
  const types = new Map<string, GraphQLTypeEntry>();
  const queryFields: Record<string, GraphQLFieldDefinition> = {};
  const mutationFields: Record<string, GraphQLFieldDefinition> = {};
  const fieldToEntitySlug = new Map<string, string>();

  // Built-in scalar stubs — parser validation looks these up.
  for (const scalar of ["String", "Int", "Float", "Boolean", "ID", "JSON"]) {
    types.set(scalar, {
      kind: "OBJECT",
      name: scalar,
      fields: {},
    } satisfies GraphQLObjectTypeDefinition);
  }

  for (const entity of ontologyTypes) {
    const typeName = toTypeName(entity.slug);
    const camelName = toCamelCase(entity.slug);
    const pluralName = toPluralQueryName(camelName);

    // -----------------------------------------------------------------
    // Build the Object type fields
    // -----------------------------------------------------------------
    const fields: Record<string, GraphQLFieldDefinition> = {
      // System-generated fields present on every entity record
      id: { type: "ID", nullable: false, isList: false },
      _tenantId: { type: "String", nullable: false, isList: false },
      _createdAt: { type: "String", nullable: false, isList: false },
      _updatedAt: { type: "String", nullable: false, isList: false },
    };

    for (const f of entity.fields) {
      const mapping = FIELD_TYPE_TO_GQL[f.fieldType] ?? { gqlType: "String", isList: false };
      fields[f.slug] = {
        type: mapping.gqlType,
        nullable: f.nullable || !f.required,
        isList: mapping.isList,
      };
    }

    types.set(typeName, {
      kind: "OBJECT",
      name: typeName,
      fields,
    } satisfies GraphQLObjectTypeDefinition);

    // -----------------------------------------------------------------
    // Connection type for paginated list results
    // -----------------------------------------------------------------
    const connectionTypeName = `${typeName}Connection`;
    types.set(connectionTypeName, {
      kind: "OBJECT",
      name: connectionTypeName,
      fields: {
        nodes:      { type: typeName, nullable: false, isList: true },
        nextCursor: { type: "String", nullable: true,  isList: false },
        total:      { type: "Int",    nullable: true,  isList: false },
      },
    } satisfies GraphQLObjectTypeDefinition);

    // -----------------------------------------------------------------
    // Query: entityType(id: ID!): EntityType
    // -----------------------------------------------------------------
    const singleQueryName = camelName;
    queryFields[singleQueryName] = {
      type: typeName,
      nullable: true,
      isList: false,
      args: {
        id: { type: "ID", nullable: false },
      },
    };
    fieldToEntitySlug.set(singleQueryName, entity.slug);

    // -----------------------------------------------------------------
    // Query: entityTypes(filter, pagination): EntityTypeConnection
    // -----------------------------------------------------------------
    queryFields[pluralName] = {
      type: connectionTypeName,
      nullable: false,
      isList: false,
      args: LIST_ARGS,
    };
    fieldToEntitySlug.set(pluralName, entity.slug);

    // -----------------------------------------------------------------
    // Mutation: createEntityType(input: JSON!): EntityType
    // -----------------------------------------------------------------
    const createMutationName = `create${typeName}`;
    mutationFields[createMutationName] = {
      type: typeName,
      nullable: false,
      isList: false,
      args: {
        input: { type: "JSON", nullable: false },
      },
    };
    fieldToEntitySlug.set(createMutationName, entity.slug);

    // -----------------------------------------------------------------
    // Mutation: updateEntityType(id: ID!, input: JSON!): EntityType
    // -----------------------------------------------------------------
    const updateMutationName = `update${typeName}`;
    mutationFields[updateMutationName] = {
      type: typeName,
      nullable: false,
      isList: false,
      args: {
        id:    { type: "ID",   nullable: false },
        input: { type: "JSON", nullable: false },
      },
    };
    fieldToEntitySlug.set(updateMutationName, entity.slug);

    // -----------------------------------------------------------------
    // Mutation: deleteEntityType(id: ID!): Boolean
    // -----------------------------------------------------------------
    const deleteMutationName = `delete${typeName}`;
    mutationFields[deleteMutationName] = {
      type: "Boolean",
      nullable: false,
      isList: false,
      args: {
        id: { type: "ID", nullable: false },
      },
    };
    fieldToEntitySlug.set(deleteMutationName, entity.slug);
  }

  return { types, queryFields, mutationFields, fieldToEntitySlug };
}

// ---------------------------------------------------------------------------
// Helper: derive GraphQLTypeDefinition for external consumers
// ---------------------------------------------------------------------------

export function buildTypeDefinition(entity: EntityDefinition): GraphQLTypeDefinition {
  const fields: GraphQLFieldMapping[] = [
    { ontologyField: "id",         graphqlType: "ID",     nullable: false, isList: false },
    { ontologyField: "_tenantId",  graphqlType: "String", nullable: false, isList: false },
    { ontologyField: "_createdAt", graphqlType: "String", nullable: false, isList: false },
    { ontologyField: "_updatedAt", graphqlType: "String", nullable: false, isList: false },
  ];

  for (const f of entity.fields) {
    const mapping = FIELD_TYPE_TO_GQL[f.fieldType] ?? { gqlType: "String", isList: false };
    fields.push({
      ontologyField: f.slug,
      graphqlType:   mapping.gqlType,
      nullable:      f.nullable || !f.required,
      isList:        mapping.isList,
    });
  }

  const camelName = toCamelCase(entity.slug);
  return {
    name:            toTypeName(entity.slug),
    fields,
    queryName:       camelName,
    queryPluralName: toPluralQueryName(camelName),
  };
}

// ---------------------------------------------------------------------------
// SDL serialisation (used by introspection and developer tooling)
// ---------------------------------------------------------------------------

export function schemaToSdl(schema: GraphQLSchema): string {
  const lines: string[] = [];

  for (const [name, typeDef] of schema.types) {
    if (typeDef.kind !== "OBJECT") continue;
    // Skip built-in scalars from the SDL output
    if (["String", "Int", "Float", "Boolean", "ID", "JSON"].includes(name)) continue;

    lines.push(`type ${name} {`);
    for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
      const baseType = fieldDef.isList ? `[${fieldDef.type}]` : fieldDef.type;
      const nullMark = fieldDef.nullable ? "" : "!";
      lines.push(`  ${fieldName}: ${baseType}${nullMark}`);
    }
    lines.push("}");
    lines.push("");
  }

  if (Object.keys(schema.queryFields).length > 0) {
    lines.push("type Query {");
    for (const [name, field] of Object.entries(schema.queryFields)) {
      const args = field.args
        ? Object.entries(field.args)
            .map(([argName, arg]) => `${argName}: ${arg.type}${arg.nullable ? "" : "!"}`)
            .join(", ")
        : "";
      const argStr = args ? `(${args})` : "";
      const returnType = field.nullable ? field.type : `${field.type}!`;
      lines.push(`  ${name}${argStr}: ${returnType}`);
    }
    lines.push("}");
    lines.push("");
  }

  if (Object.keys(schema.mutationFields).length > 0) {
    lines.push("type Mutation {");
    for (const [name, field] of Object.entries(schema.mutationFields)) {
      const args = field.args
        ? Object.entries(field.args)
            .map(([argName, arg]) => `${argName}: ${arg.type}${arg.nullable ? "" : "!"}`)
            .join(", ")
        : "";
      const argStr = args ? `(${args})` : "";
      const returnType = field.nullable ? field.type : `${field.type}!`;
      lines.push(`  ${name}${argStr}: ${returnType}`);
    }
    lines.push("}");
  }

  return lines.join("\n");
}
