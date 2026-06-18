// GraphQL introspection handler.
//
// Responds to the standard __schema and __type introspection queries
// without depending on graphql-js. The response conforms to the
// GraphQL June 2018 specification §6.4.1 so that standard tooling
// (GraphiQL, Apollo Explorer, Insomnia) can consume it.
//
// Only the subset of introspection fields needed for basic tooling is
// implemented. Fields like `deprecationReason` and `isDeprecated` are
// returned as null/false since the generated schema has no deprecations.

import type { GraphQLSchema, GraphQLTypeEntry, GraphQLObjectTypeDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Introspection type shapes (subset of the full spec)
// ---------------------------------------------------------------------------

interface IntrospectionField {
  name: string;
  description: string | null;
  args: IntrospectionInputValue[];
  type: IntrospectionTypeRef;
  isDeprecated: boolean;
  deprecationReason: string | null;
}

interface IntrospectionInputValue {
  name: string;
  description: string | null;
  type: IntrospectionTypeRef;
  defaultValue: string | null;
}

interface IntrospectionTypeRef {
  kind: "SCALAR" | "OBJECT" | "ENUM" | "NON_NULL" | "LIST" | "INPUT_OBJECT";
  name: string | null;
  ofType: IntrospectionTypeRef | null;
}

interface IntrospectionType {
  kind: "SCALAR" | "OBJECT" | "ENUM" | "INPUT_OBJECT";
  name: string;
  description: string | null;
  fields: IntrospectionField[] | null;
  inputFields: IntrospectionInputValue[] | null;
  enumValues: Array<{ name: string; description: string | null; isDeprecated: boolean; deprecationReason: string | null }> | null;
  possibleTypes: null;
  interfaces: [];
}

interface IntrospectionSchema {
  queryType: { name: string } | null;
  mutationType: { name: string } | null;
  subscriptionType: null;
  types: IntrospectionType[];
  directives: Array<{ name: string; locations: string[]; args: IntrospectionInputValue[] }>;
}

// ---------------------------------------------------------------------------
// Built-in scalars
// ---------------------------------------------------------------------------

const BUILT_IN_SCALARS = ["String", "Int", "Float", "Boolean", "ID", "JSON"];

function makeScalar(name: string): IntrospectionType {
  return {
    kind: "SCALAR",
    name,
    description: null,
    fields: null,
    inputFields: null,
    enumValues: null,
    possibleTypes: null,
    interfaces: [],
  };
}

// ---------------------------------------------------------------------------
// Type reference builder
// ---------------------------------------------------------------------------

function buildTypeRef(gqlType: string, nullable: boolean, isList: boolean): IntrospectionTypeRef {
  const innerName = gqlType.replace(/[[\]!]/g, "");
  const innerRef: IntrospectionTypeRef = {
    kind: BUILT_IN_SCALARS.includes(innerName) ? "SCALAR" : "OBJECT",
    name: innerName,
    ofType: null,
  };

  const maybeList: IntrospectionTypeRef = isList
    ? { kind: "LIST", name: null, ofType: innerRef }
    : innerRef;

  if (!nullable) {
    return { kind: "NON_NULL", name: null, ofType: maybeList };
  }
  return maybeList;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildIntrospectionResult(schema: GraphQLSchema): { __schema: IntrospectionSchema } {
  const types: IntrospectionType[] = [];

  // Built-in scalars
  for (const scalar of BUILT_IN_SCALARS) {
    types.push(makeScalar(scalar));
  }

  // Schema-generated types
  for (const [name, typeDef] of schema.types) {
    if (BUILT_IN_SCALARS.includes(name)) continue;

    if (typeDef.kind === "OBJECT") {
      types.push(buildObjectType(name, typeDef));
    } else if (typeDef.kind === "ENUM") {
      types.push({
        kind: "ENUM",
        name,
        description: null,
        fields: null,
        inputFields: null,
        enumValues: typeDef.values.map((v) => ({
          name: v,
          description: null,
          isDeprecated: false,
          deprecationReason: null,
        })),
        possibleTypes: null,
        interfaces: [],
      });
    }
  }

  // Add Query and Mutation pseudo-types
  const hasQueries = Object.keys(schema.queryFields).length > 0;
  const hasMutations = Object.keys(schema.mutationFields).length > 0;

  if (hasQueries) {
    types.push(buildRootType("Query", schema.queryFields));
  }
  if (hasMutations) {
    types.push(buildRootType("Mutation", schema.mutationFields));
  }

  return {
    __schema: {
      queryType: hasQueries ? { name: "Query" } : null,
      mutationType: hasMutations ? { name: "Mutation" } : null,
      subscriptionType: null,
      types,
      directives: [
        {
          name: "skip",
          locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"],
          args: [
            {
              name: "if",
              description: null,
              type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "Boolean", ofType: null } },
              defaultValue: null,
            },
          ],
        },
        {
          name: "include",
          locations: ["FIELD", "FRAGMENT_SPREAD", "INLINE_FRAGMENT"],
          args: [
            {
              name: "if",
              description: null,
              type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "Boolean", ofType: null } },
              defaultValue: null,
            },
          ],
        },
      ],
    },
  };
}

function buildObjectType(
  name: string,
  typeDef: GraphQLObjectTypeDefinition,
): IntrospectionType {
  const fields: IntrospectionField[] = Object.entries(typeDef.fields).map(
    ([fieldName, fieldDef]) => ({
      name: fieldName,
      description: null,
      args: fieldDef.args
        ? Object.entries(fieldDef.args).map(([argName, argDef]) => ({
            name: argName,
            description: null,
            type: buildTypeRef(argDef.type, argDef.nullable, false),
            defaultValue: argDef.defaultValue !== undefined ? String(argDef.defaultValue) : null,
          }))
        : [],
      type: buildTypeRef(fieldDef.type, fieldDef.nullable, fieldDef.isList),
      isDeprecated: false,
      deprecationReason: null,
    }),
  );

  return {
    kind: "OBJECT",
    name,
    description: null,
    fields,
    inputFields: null,
    enumValues: null,
    possibleTypes: null,
    interfaces: [],
  };
}

function buildRootType(
  name: string,
  fields: Record<string, import("./types.js").GraphQLFieldDefinition>,
): IntrospectionType {
  const introspectionFields: IntrospectionField[] = Object.entries(fields).map(
    ([fieldName, fieldDef]) => ({
      name: fieldName,
      description: null,
      args: fieldDef.args
        ? Object.entries(fieldDef.args).map(([argName, argDef]) => ({
            name: argName,
            description: null,
            type: buildTypeRef(argDef.type, argDef.nullable, false),
            defaultValue: null,
          }))
        : [],
      type: buildTypeRef(fieldDef.type, fieldDef.nullable, fieldDef.isList),
      isDeprecated: false,
      deprecationReason: null,
    }),
  );

  return {
    kind: "OBJECT",
    name,
    description: null,
    fields: introspectionFields,
    inputFields: null,
    enumValues: null,
    possibleTypes: null,
    interfaces: [],
  };
}

// ---------------------------------------------------------------------------
// Introspection query detector
// ---------------------------------------------------------------------------

/**
 * Returns true if the parsed document is a pure introspection query that
 * only selects __schema or __type. Used to short-circuit normal resolver
 * execution and return the pre-built introspection result.
 */
export function isIntrospectionQuery(doc: import("./types.js").GraphQLDocument): boolean {
  for (const op of doc.operations) {
    if (op.kind !== "query") continue;
    for (const sel of op.selectionSet.selections) {
      if (sel.kind === "FragmentSpread" || sel.kind === "InlineFragment") continue;
      if (sel.name === "__schema" || sel.name === "__type") return true;
    }
  }
  return false;
}
