// GraphQL query parser — hand-rolled, no external graphql-js dependency.
//
// Parses a GraphQL query/mutation string into a GraphQLDocument AST.
// Supports:
//   - query / mutation operations (named and anonymous)
//   - field selection sets with aliases
//   - arguments (all literal types + variables)
//   - variable definitions with type annotations
//   - named fragments (definition + spread)
//   - inline fragments
//   - directives (stored as names only; not executed)
//
// Validation checks performed during parsing:
//   - Unknown operation types
//   - Max query depth (default 5 levels) to prevent exponential resolver abuse
//   - Unknown fragment spreads resolved against the document's fragment map
//   - Duplicate fragment names
//
// The schema-aware validation (field existence, arg types) is a separate step
// performed by validateDocument() so the parser can be tested independently.

import type {
  GraphQLDocument,
  GraphQLOperationDefinition,
  GraphQLFragmentDefinition,
  GraphQLSelectionSet,
  GraphQLSelection,
  GraphQLField,
  GraphQLArgument,
  GraphQLValue,
  GraphQLVariableDefinition,
  GraphQLInlineFragment,
  GraphQLFragmentSpread,
} from "./types.js";
import type { GraphQLSchema } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParseOptions {
  /** Maximum allowed selection-set nesting depth. Defaults to 5. */
  maxDepth?: number;
  /** Maximum allowed number of field aliases per document. Defaults to 50. */
  maxAliases?: number;
}

export interface ParseError {
  message: string;
  line: number;
  column: number;
}

export type ParseResult =
  | { ok: true; document: GraphQLDocument }
  | { ok: false; errors: ParseError[] };

export function parseDocument(source: string, options: ParseOptions = {}): ParseResult {
  const maxDepth = options.maxDepth ?? 5;
  const maxAliases = options.maxAliases ?? 50;
  const parser = new Parser(source, maxDepth, maxAliases);
  return parser.parse();
}

// ---------------------------------------------------------------------------
// Schema-aware validation (called after parsing succeeds)
// ---------------------------------------------------------------------------

export interface ValidationError {
  message: string;
  path: string;
}

export function validateDocument(
  doc: GraphQLDocument,
  schema: GraphQLSchema,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const op of doc.operations) {
    const rootFields =
      op.kind === "mutation" ? schema.mutationFields : schema.queryFields;

    validateSelectionSet(
      op.selectionSet,
      rootFields,
      schema,
      doc,
      op.kind,
      errors,
    );
  }

  return errors;
}

function validateSelectionSet(
  set: GraphQLSelectionSet,
  parentFields: Record<string, import("./types.js").GraphQLFieldDefinition>,
  schema: GraphQLSchema,
  doc: GraphQLDocument,
  path: string,
  errors: ValidationError[],
): void {
  for (const sel of set.selections) {
    if (sel.kind === "FragmentSpread") {
      const frag = doc.fragments.get(sel.name);
      if (!frag) {
        errors.push({ message: `Unknown fragment '${sel.name}'.`, path });
      }
      // Fragment body validation is deferred — fragments may spread into
      // multiple types and we lack full type-tracking here.
      continue;
    }

    if (sel.kind === "InlineFragment") {
      // Validate inline fragment selections against the same parent fields
      validateSelectionSet(sel.selectionSet, parentFields, schema, doc, path, errors);
      continue;
    }

    // Regular field
    const field = parentFields[sel.name];
    if (!field) {
      errors.push({
        message: `Field '${sel.name}' does not exist on '${path}'.`,
        path: `${path}.${sel.name}`,
      });
      continue;
    }

    // Validate arguments
    if (sel.arguments.length > 0 && field.args) {
      for (const arg of sel.arguments) {
        if (!field.args[arg.name]) {
          errors.push({
            message: `Unknown argument '${arg.name}' on field '${sel.name}'.`,
            path: `${path}.${sel.name}`,
          });
        }
      }
    }

    // Recurse into sub-selection if present
    if (sel.selectionSet) {
      const childType = schema.types.get(field.type);
      if (childType?.kind === "OBJECT" && Object.keys(childType.fields).length > 0) {
        validateSelectionSet(
          sel.selectionSet,
          childType.fields,
          schema,
          doc,
          `${path}.${sel.name}`,
          errors,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

type TokenType =
  | "NAME"
  | "STRING"
  | "INT"
  | "FLOAT"
  | "PUNCTUATOR"   // { } ( ) [ ] : = @ ! | & ...
  | "EOF";

interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

class Lexer {
  private pos = 0;
  private line = 1;
  private column = 1;

  constructor(private readonly src: string) {}

  private advance(): string {
    const ch = this.src[this.pos] ?? "";
    this.pos++;
    if (ch === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return ch;
  }

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ",") {
        this.advance();
      } else if (ch === "#") {
        // Single-line comment
        while (this.pos < this.src.length && this.peek() !== "\n") {
          this.advance();
        }
      } else {
        break;
      }
    }
  }

  next(): Token {
    this.skipWhitespaceAndComments();

    if (this.pos >= this.src.length) {
      return { type: "EOF", value: "", line: this.line, column: this.column };
    }

    const line = this.line;
    const column = this.column;
    const ch = this.peek();

    // Punctuators
    const PUNCTUATORS = new Set(["{", "}", "(", ")", "[", "]", ":", "=", "@", "!", "|", "&"]);
    if (PUNCTUATORS.has(ch)) {
      this.advance();
      return { type: "PUNCTUATOR", value: ch, line, column };
    }

    // Spread operator ...
    if (ch === "." && this.src.slice(this.pos, this.pos + 3) === "...") {
      this.advance(); this.advance(); this.advance();
      return { type: "PUNCTUATOR", value: "...", line, column };
    }

    // String (block strings ''' not supported — not needed for the subset we parse)
    if (ch === '"') {
      return this.readString(line, column);
    }

    // Number
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      return this.readNumber(line, column);
    }

    // Name (identifier, keyword)
    if (isNameStart(ch)) {
      return this.readName(line, column);
    }

    // Unknown character — advance to avoid infinite loop
    this.advance();
    return { type: "NAME", value: ch, line, column };
  }

  private readString(line: number, column: number): Token {
    this.advance(); // consume opening "
    let value = "";
    while (this.pos < this.src.length) {
      const ch = this.advance();
      if (ch === '"') break;
      if (ch === "\\") {
        const esc = this.advance();
        switch (esc) {
          case '"':  value += '"'; break;
          case "\\": value += "\\"; break;
          case "n":  value += "\n"; break;
          case "r":  value += "\r"; break;
          case "t":  value += "\t"; break;
          case "u": {
            const hex = this.src.slice(this.pos, this.pos + 4);
            value += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            this.column += 4;
            break;
          }
          default: value += esc;
        }
      } else {
        value += ch;
      }
    }
    return { type: "STRING", value, line, column };
  }

  private readNumber(line: number, column: number): Token {
    let raw = "";
    if (this.peek() === "-") raw += this.advance();
    while (this.pos < this.src.length && isDigit(this.peek())) {
      raw += this.advance();
    }
    let isFloat = false;
    if (this.peek() === ".") {
      isFloat = true;
      raw += this.advance();
      while (this.pos < this.src.length && isDigit(this.peek())) {
        raw += this.advance();
      }
    }
    if (this.peek() === "e" || this.peek() === "E") {
      isFloat = true;
      raw += this.advance();
      if (this.peek() === "+" || this.peek() === "-") raw += this.advance();
      while (this.pos < this.src.length && isDigit(this.peek())) {
        raw += this.advance();
      }
    }
    return { type: isFloat ? "FLOAT" : "INT", value: raw, line, column };
  }

  private readName(line: number, column: number): Token {
    let value = "";
    while (this.pos < this.src.length && isNameContinue(this.peek())) {
      value += this.advance();
    }
    return { type: "NAME", value, line, column };
  }
}

function isNameStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isNameContinue(ch: string): boolean {
  return isNameStart(ch) || (ch >= "0" && ch <= "9");
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private readonly lexer: Lexer;
  private current: Token;
  private readonly errors: ParseError[] = [];
  private aliasCount = 0;

  constructor(src: string, private readonly maxDepth: number, private readonly maxAliases: number) {
    this.lexer = new Lexer(src);
    this.current = this.lexer.next();
  }

  // Advance and return previous token
  private advance(): Token {
    const prev = this.current;
    this.current = this.lexer.next();
    return prev;
  }

  private peek(): Token {
    return this.current;
  }

  // Returns the current token's value as a plain string to defeat TypeScript's
  // control-flow narrowing of `this.current.value`. Class property accesses can
  // retain a narrowed type across method calls; reading through a function call
  // forces TypeScript to treat the return as `string`.
  private cv(): string {
    return this.current.value as string;
  }

  // Returns the current token's type as TokenType (same reason as cv()).
  private ct(): TokenType {
    return this.current.type as TokenType;
  }

  private expect(type: TokenType, value?: string): Token {
    const tok = this.current;
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      this.errors.push({
        message: `Expected ${value ?? type} but got '${tok.value}'`,
        line: tok.line,
        column: tok.column,
      });
      // Soft recovery: return what we have and advance
      this.advance();
      return tok;
    }
    return this.advance();
  }

  private skip(value: string): boolean {
    if (this.current.value === value) {
      this.advance();
      return true;
    }
    return false;
  }

  parse(): ParseResult {
    const operations: GraphQLOperationDefinition[] = [];
    const fragments = new Map<string, GraphQLFragmentDefinition>();

    while (this.current.type !== "EOF") {
      if (this.current.value === "fragment") {
        const frag = this.parseFragmentDefinition();
        if (frag) {
          if (fragments.has(frag.name)) {
            this.errors.push({
              message: `Duplicate fragment name '${frag.name}'.`,
              line: this.current.line,
              column: this.current.column,
            });
          } else {
            fragments.set(frag.name, frag);
          }
        }
      } else {
        const op = this.parseOperation();
        if (op) operations.push(op);
      }
    }

    if (this.errors.length > 0) {
      return { ok: false, errors: this.errors };
    }

    // Validate max depth across all operations
    for (const op of operations) {
      const depth = selectionSetDepth(op.selectionSet, fragments, 0, new Set());
      if (depth > this.maxDepth) {
        return {
          ok: false,
          errors: [{
            message: `Query exceeds maximum allowed depth of ${this.maxDepth} (got ${depth}).`,
            line: 1,
            column: 1,
          }],
        };
      }
    }

    return { ok: true, document: { operations, fragments } };
  }

  private parseOperation(): GraphQLOperationDefinition | null {
    let kind: "query" | "mutation" | "subscription" = "query";
    let name: string | null = null;
    const variableDefinitions: GraphQLVariableDefinition[] = [];

    const opKeyword = this.cv();
    if (opKeyword === "query" || opKeyword === "mutation" || opKeyword === "subscription") {
      kind = opKeyword;
      this.advance();
      if (this.ct() === "NAME") {
        name = this.advance().value;
      }
    } else if (opKeyword !== "{") {
      this.errors.push({
        message: `Unknown operation type '${opKeyword}'. Expected query, mutation, or {.`,
        line: this.current.line,
        column: this.current.column,
      });
      this.advance();
      return null;
    }

    // Variable definitions
    if (this.cv() === "(") {
      this.advance();
      while (this.cv() !== ")" && this.ct() !== "EOF") {
        const varDef = this.parseVariableDefinition();
        if (varDef) variableDefinitions.push(varDef);
      }
      this.expect("PUNCTUATOR", ")");
    }

    const selectionSet = this.parseSelectionSet(0);
    if (!selectionSet) return null;

    return { kind, name, variableDefinitions, selectionSet };
  }

  private parseVariableDefinition(): GraphQLVariableDefinition | null {
    if (this.cv() !== "$") {
      this.errors.push({
        message: `Expected variable starting with $ but got '${this.cv()}'`,
        line: this.current.line,
        column: this.current.column,
      });
      this.advance();
      return null;
    }
    this.advance(); // consume $
    const name = this.expect("NAME").value;
    this.expect("PUNCTUATOR", ":");
    const { typeName, nullable, isList } = this.parseTypeRef();

    let defaultValue: GraphQLValue | undefined;
    if (this.cv() === "=") {
      this.advance();
      defaultValue = this.parseValue();
    }

    return { name, type: typeName, nullable, isList, ...(defaultValue !== undefined ? { defaultValue } : {}) };
  }

  private parseTypeRef(): { typeName: string; nullable: boolean; isList: boolean } {
    let isList = false;
    let typeName = "";
    let nullable = true;

    if (this.cv() === "[") {
      isList = true;
      this.advance();
      typeName = this.expect("NAME").value;
      if (this.cv() === "!") this.advance(); // inner non-null
      this.expect("PUNCTUATOR", "]");
    } else {
      typeName = this.expect("NAME").value;
    }

    if (this.cv() === "!") {
      nullable = false;
      this.advance();
    }

    return { typeName, nullable, isList };
  }

  private parseSelectionSet(depth: number): GraphQLSelectionSet | null {
    if (this.cv() !== "{") {
      this.errors.push({
        message: `Expected { but got '${this.cv()}'`,
        line: this.current.line,
        column: this.current.column,
      });
      return null;
    }
    this.advance();

    const selections: GraphQLSelection[] = [];

    while (this.cv() !== "}" && this.ct() !== "EOF") {
      // Fragment spread or inline fragment
      if (this.cv() === "...") {
        this.advance();
        if (this.cv() === "on") {
          // Inline fragment
          this.advance();
          const typeCondition = this.expect("NAME").value;
          const subSet = this.parseSelectionSet(depth + 1);
          if (subSet) {
            selections.push({
              kind: "InlineFragment",
              typeCondition,
              selectionSet: subSet,
            } satisfies GraphQLInlineFragment);
          }
        } else if (this.ct() === "NAME") {
          // Named fragment spread
          const fragName = this.advance().value;
          selections.push({
            kind: "FragmentSpread",
            name: fragName,
          } satisfies GraphQLFragmentSpread);
        } else {
          // Bare ... with neither on nor name — inline fragment on current type
          const subSet = this.parseSelectionSet(depth + 1);
          if (subSet) {
            selections.push({
              kind: "InlineFragment",
              typeCondition: null,
              selectionSet: subSet,
            } satisfies GraphQLInlineFragment);
          }
        }
        continue;
      }

      const field = this.parseField(depth);
      if (field) selections.push(field);
    }

    this.expect("PUNCTUATOR", "}");
    return { selections };
  }

  private parseField(depth: number): GraphQLField | null {
    if (this.ct() !== "NAME") {
      this.errors.push({
        message: `Expected field name but got '${this.cv()}'`,
        line: this.current.line,
        column: this.current.column,
      });
      this.advance();
      return null;
    }

    let alias: string | null = null;
    let name = this.advance().value;

    // Alias: nameOrAlias ":" name
    if (this.cv() === ":") {
      alias = name;
      this.advance();
      name = this.expect("NAME").value;
      this.aliasCount++;
      if (this.aliasCount > this.maxAliases) {
        this.errors.push({
          message: `Query exceeds maximum allowed alias count of ${this.maxAliases}.`,
          line: this.current.line,
          column: this.current.column,
        });
        return null;
      }
    }

    // Arguments
    const args: GraphQLArgument[] = [];
    if (this.cv() === "(") {
      this.advance();
      while (this.cv() !== ")" && this.ct() !== "EOF") {
        const argName = this.expect("NAME").value;
        this.expect("PUNCTUATOR", ":");
        const argValue = this.parseValue();
        args.push({ name: argName, value: argValue });
      }
      this.expect("PUNCTUATOR", ")");
    }

    // Directives
    const directives: string[] = [];
    while (this.cv() === "@") {
      this.advance();
      directives.push(this.expect("NAME").value);
      // Skip directive arguments if present
      if (this.cv() === "(") {
        this.advance();
        let depth2 = 1;
        while (this.ct() !== "EOF" && depth2 > 0) {
          if (this.cv() === "(") depth2++;
          else if (this.cv() === ")") depth2--;
          this.advance();
        }
      }
    }

    // Sub-selection
    let selectionSet: GraphQLSelectionSet | null = null;
    if (this.cv() === "{") {
      selectionSet = this.parseSelectionSet(depth + 1);
    }

    return { kind: "Field", alias, name, arguments: args, directives, selectionSet };
  }

  private parseValue(): GraphQLValue {
    const tok = this.current;

    if (tok.value === "$") {
      this.advance();
      const varName = this.expect("NAME").value;
      return { kind: "Variable", name: varName };
    }

    if (tok.type === "STRING") {
      this.advance();
      return { kind: "StringValue", value: tok.value };
    }

    if (tok.type === "INT") {
      this.advance();
      return { kind: "IntValue", value: parseInt(tok.value, 10) };
    }

    if (tok.type === "FLOAT") {
      this.advance();
      return { kind: "FloatValue", value: parseFloat(tok.value) };
    }

    if (tok.value === "true") {
      this.advance();
      return { kind: "BooleanValue", value: true };
    }

    if (tok.value === "false") {
      this.advance();
      return { kind: "BooleanValue", value: false };
    }

    if (tok.value === "null") {
      this.advance();
      return { kind: "NullValue" };
    }

    if (tok.value === "[") {
      this.advance();
      const values: GraphQLValue[] = [];
      while (this.cv() !== "]" && this.ct() !== "EOF") {
        values.push(this.parseValue());
      }
      this.expect("PUNCTUATOR", "]");
      return { kind: "ListValue", values };
    }

    if (tok.value === "{") {
      this.advance();
      const fields: Record<string, GraphQLValue> = {};
      while (this.cv() !== "}" && this.ct() !== "EOF") {
        const key = this.expect("NAME").value;
        this.expect("PUNCTUATOR", ":");
        fields[key] = this.parseValue();
      }
      this.expect("PUNCTUATOR", "}");
      return { kind: "ObjectValue", fields };
    }

    // Treat any NAME as an enum value
    if (tok.type === "NAME") {
      this.advance();
      return { kind: "EnumValue", value: tok.value };
    }

    this.errors.push({
      message: `Unexpected token '${tok.value}' while parsing value`,
      line: tok.line,
      column: tok.column,
    });
    this.advance();
    return { kind: "NullValue" };
  }

  private parseFragmentDefinition(): GraphQLFragmentDefinition | null {
    this.expect("NAME", "fragment");
    const name = this.expect("NAME").value;
    this.expect("NAME", "on");
    const typeCondition = this.expect("NAME").value;
    const selectionSet = this.parseSelectionSet(0);
    if (!selectionSet) return null;
    return { name, typeCondition, selectionSet };
  }
}

// ---------------------------------------------------------------------------
// Depth calculation (recursive — fragments are expanded inline)
// ---------------------------------------------------------------------------

function selectionSetDepth(
  set: GraphQLSelectionSet,
  fragments: Map<string, GraphQLFragmentDefinition>,
  current: number,
  visited: Set<string>,
): number {
  let max = current;
  for (const sel of set.selections) {
    if (sel.kind === "FragmentSpread") {
      if (visited.has(sel.name)) {
        return Infinity;
      }
      const frag = fragments.get(sel.name);
      if (frag) {
        const nextVisited = new Set(visited);
        nextVisited.add(sel.name);
        max = Math.max(max, selectionSetDepth(frag.selectionSet, fragments, current, nextVisited));
      }
    } else if (sel.kind === "InlineFragment") {
      max = Math.max(max, selectionSetDepth(sel.selectionSet, fragments, current + 1, visited));
    } else {
      const fieldDepth = current + 1;
      max = Math.max(max, fieldDepth);
      if (sel.selectionSet) {
        max = Math.max(max, selectionSetDepth(sel.selectionSet, fragments, fieldDepth, visited));
      }
    }
  }
  return max;
}
