// GraphQL layer type definitions.
//
// These types describe the mapping between ontology field types and GraphQL
// scalar types, and the generated type/query/mutation structure for each
// ontology entity. They are the contract shared by schema-builder, resolver-
// factory, and the parser.

// ---------------------------------------------------------------------------
// Ontology ↔ GraphQL type bridge
// ---------------------------------------------------------------------------

export interface GraphQLFieldMapping {
  ontologyField: string;
  graphqlType: string;
  nullable: boolean;
  isList: boolean;
}

export interface GraphQLTypeDefinition {
  name: string;
  fields: GraphQLFieldMapping[];
  queryName: string;
  queryPluralName: string;
}

// ---------------------------------------------------------------------------
// Built schema representation (post-generation, used by resolvers + parser)
// ---------------------------------------------------------------------------

export interface GraphQLEnumTypeDefinition {
  kind: "ENUM";
  name: string;
  values: string[];
}

export interface GraphQLObjectTypeDefinition {
  kind: "OBJECT";
  name: string;
  fields: Record<string, GraphQLFieldDefinition>;
}

export interface GraphQLFieldDefinition {
  type: string;       // e.g. "String", "Float", "[String]"
  nullable: boolean;
  isList: boolean;
  args?: Record<string, GraphQLArgDefinition>;
}

export interface GraphQLArgDefinition {
  type: string;
  nullable: boolean;
  defaultValue?: unknown;
}

export type GraphQLTypeEntry = GraphQLObjectTypeDefinition | GraphQLEnumTypeDefinition;

export interface GraphQLSchema {
  types: Map<string, GraphQLTypeEntry>;
  queryFields: Record<string, GraphQLFieldDefinition>;
  mutationFields: Record<string, GraphQLFieldDefinition>;
  // Maps query/mutation field names back to the entity slug they operate on,
  // so the resolver factory can route to the correct ontology endpoint.
  fieldToEntitySlug: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Parsed AST nodes
// ---------------------------------------------------------------------------

export interface GraphQLVariable {
  name: string;
}

export type GraphQLValue =
  | { kind: "StringValue"; value: string }
  | { kind: "IntValue"; value: number }
  | { kind: "FloatValue"; value: number }
  | { kind: "BooleanValue"; value: boolean }
  | { kind: "NullValue" }
  | { kind: "EnumValue"; value: string }
  | { kind: "ListValue"; values: GraphQLValue[] }
  | { kind: "ObjectValue"; fields: Record<string, GraphQLValue> }
  | { kind: "Variable"; name: string };

export interface GraphQLArgument {
  name: string;
  value: GraphQLValue;
}

export interface GraphQLField {
  kind: "Field";
  alias: string | null;
  name: string;
  arguments: GraphQLArgument[];
  directives: string[];
  selectionSet: GraphQLSelectionSet | null;
}

export interface GraphQLInlineFragment {
  kind: "InlineFragment";
  typeCondition: string | null;
  selectionSet: GraphQLSelectionSet;
}

export interface GraphQLFragmentSpread {
  kind: "FragmentSpread";
  name: string;
}

export type GraphQLSelection = GraphQLField | GraphQLInlineFragment | GraphQLFragmentSpread;

export interface GraphQLSelectionSet {
  selections: GraphQLSelection[];
}

export interface GraphQLFragmentDefinition {
  name: string;
  typeCondition: string;
  selectionSet: GraphQLSelectionSet;
}

export interface GraphQLVariableDefinition {
  name: string;
  type: string;
  nullable: boolean;
  isList: boolean;
  defaultValue?: GraphQLValue;
}

export interface GraphQLOperationDefinition {
  kind: "query" | "mutation" | "subscription";
  name: string | null;
  variableDefinitions: GraphQLVariableDefinition[];
  selectionSet: GraphQLSelectionSet;
}

export interface GraphQLDocument {
  operations: GraphQLOperationDefinition[];
  fragments: Map<string, GraphQLFragmentDefinition>;
}

// ---------------------------------------------------------------------------
// Runtime resolver context
// ---------------------------------------------------------------------------

export interface ResolverContext {
  tenantId: string;
  userId: string;
  roles: string[];
  scopes: string[];
  serviceToken: string;
  ontologyServiceUrl: string;
  ingestionServiceUrl: string;
}

export interface PaginationArgs {
  after?: string;
  first?: number;
  before?: string;
  last?: number;
}

export interface FilterArg {
  field: string;
  op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "contains" | "startsWith";
  value: unknown;
}

export interface SortArg {
  field: string;
  direction: "ASC" | "DESC";
}

// ---------------------------------------------------------------------------
// GraphQL execution result
// ---------------------------------------------------------------------------

export interface GraphQLError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

export interface GraphQLExecutionResult {
  data?: Record<string, unknown> | null;
  errors?: GraphQLError[];
}
