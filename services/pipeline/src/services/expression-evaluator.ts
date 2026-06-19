// Safe expression evaluator for transform step filter/map conditions.
//
// WHY a custom evaluator instead of eval() or Function():
//   - eval() gives arbitrary code execution access — unacceptable in a
//     multi-tenant pipeline runtime where expressions come from user input.
//   - External sandboxed-eval libraries add complexity; the grammar we need
//     (field refs, comparisons, arithmetic, string ops) is small enough to
//     parse ourselves with a Pratt parser in ~200 lines.
//
// Supported grammar (in order of binding power, low → high):
//   expr    = logic_or
//   logic_or  = logic_and ('||' logic_and)*
//   logic_and = equality ('&&' equality)*
//   equality  = comparison (('==' | '!=') comparison)*
//   comparison = addition (('<' | '<=' | '>' | '>=') addition)*
//   addition  = multiply (('+' | '-') multiply)*
//   multiply  = unary (('*' | '/' | '%') unary)*
//   unary     = ('!' | '-') unary | primary
//   primary   = NUMBER | STRING | BOOL | NULL | IDENT ('.' IDENT)* | '(' expr ')'
//             | IDENT '(' args ')' — built-in function calls
//
// Built-in functions: startsWith, endsWith, includes, toLowerCase, toUpperCase,
//   trim, length, toString, toNumber, isNull, isNotNull
//
// Security constraints (enforced in tokenizer and evaluator):
//   - No access to globalThis / process / require / import
//   - No prototype chain traversal (__proto__, constructor, prototype)
//   - Field references are resolved only against the provided record context
//   - Max expression length: 2000 characters
//   - Max AST depth: 50 nodes (prevents deeply nested exponential blowup)

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface EvalContext {
  record: Record<string, unknown>;
}

export class ExpressionEvaluatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionEvaluatorError";
  }
}

/**
 * Evaluates an expression string against a record context.
 * Returns the result value; callers cast to the expected type.
 * Throws ExpressionEvaluatorError for syntax or evaluation errors.
 */
export function evaluate(expression: string, ctx: EvalContext): unknown {
  if (expression.length > 2000) {
    throw new ExpressionEvaluatorError(
      "Expression exceeds 2000 character limit.",
    );
  }
  const tokens = tokenize(expression);
  const parser = new Parser(tokens);
  const ast = parser.parseExpression(0);
  if (parser.pos < tokens.length) {
    throw new ExpressionEvaluatorError(
      `Unexpected token "${tokens[parser.pos]?.raw}" at position ${parser.pos}.`,
    );
  }
  return evalNode(ast, ctx, 0);
}

/**
 * Evaluates a boolean expression — convenience wrapper that coerces result.
 * Used by filter operations.
 */
export function evaluateBoolean(expression: string, ctx: EvalContext): boolean {
  return isTruthy(evaluate(expression, ctx));
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenType =
  | "NUMBER"
  | "STRING"
  | "IDENT"
  | "BOOL"
  | "NULL"
  | "OP"
  | "LPAREN"
  | "RPAREN"
  | "COMMA"
  | "DOT"
  | "EOF";

interface Token {
  type: TokenType;
  raw: string;
  value: unknown;
}

// Identifiers that are not allowed as field references (security)
const BLOCKED_IDENTS = new Set([
  "globalThis",
  "global",
  "process",
  "require",
  "import",
  "__proto__",
  "constructor",
  "prototype",
  "eval",
  "Function",
  "setTimeout",
  "setInterval",
  "fetch",
  "window",
  "document",
]);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    // Skip whitespace
    if (/\s/.test(src[i]!)) {
      i++;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(src[i]!)) {
      let num = "";
      while (i < src.length && /[0-9.]/.test(src[i]!)) {
        num += src[i++];
      }
      tokens.push({ type: "NUMBER", raw: num, value: Number(num) });
      continue;
    }

    // Strings (single or double quoted)
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i++];
      let str = "";
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") {
          i++;
          const esc = src[i++];
          str += esc === "n" ? "\n" : esc === "t" ? "\t" : (esc ?? "");
        } else {
          str += src[i++];
        }
      }
      i++; // closing quote
      tokens.push({ type: "STRING", raw: `${quote}${str}${quote}`, value: str });
      continue;
    }

    // Two-char operators
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      tokens.push({ type: "OP", raw: two, value: two });
      i += 2;
      continue;
    }

    // Single-char operators and punctuation
    if ("<>+-*/%!".includes(src[i]!)) {
      tokens.push({ type: "OP", raw: src[i]!, value: src[i] });
      i++;
      continue;
    }
    if (src[i] === "(") { tokens.push({ type: "LPAREN", raw: "(", value: "(" }); i++; continue; }
    if (src[i] === ")") { tokens.push({ type: "RPAREN", raw: ")", value: ")" }); i++; continue; }
    if (src[i] === ",") { tokens.push({ type: "COMMA", raw: ",", value: "," }); i++; continue; }
    if (src[i] === ".") { tokens.push({ type: "DOT", raw: ".", value: "." }); i++; continue; }

    // Identifiers (keywords + field names + function names)
    if (/[a-zA-Z_$]/.test(src[i]!)) {
      let id = "";
      while (i < src.length && /[a-zA-Z0-9_$]/.test(src[i]!)) {
        id += src[i++];
      }
      if (id === "true") {
        tokens.push({ type: "BOOL", raw: id, value: true });
      } else if (id === "false") {
        tokens.push({ type: "BOOL", raw: id, value: false });
      } else if (id === "null") {
        tokens.push({ type: "NULL", raw: id, value: null });
      } else if (BLOCKED_IDENTS.has(id)) {
        throw new ExpressionEvaluatorError(
          `Identifier "${id}" is not permitted in expressions.`,
        );
      } else {
        tokens.push({ type: "IDENT", raw: id, value: id });
      }
      continue;
    }

    throw new ExpressionEvaluatorError(
      `Unexpected character "${src[i]}" at position ${i}.`,
    );
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// AST nodes
// ---------------------------------------------------------------------------

type AstNode =
  | { kind: "literal"; value: unknown }
  | { kind: "field"; path: string[] }
  | { kind: "unary"; op: string; operand: AstNode }
  | { kind: "binary"; op: string; left: AstNode; right: AstNode }
  | { kind: "call"; name: string; args: AstNode[] };

// ---------------------------------------------------------------------------
// Pratt parser
// ---------------------------------------------------------------------------

// Binding powers for infix operators (left binding power)
const INFIX_POWER: Record<string, number> = {
  "||": 10,
  "&&": 20,
  "==": 30,
  "!=": 30,
  "<":  40,
  "<=": 40,
  ">":  40,
  ">=": 40,
  "+":  50,
  "-":  50,
  "*":  60,
  "/":  60,
  "%":  60,
};

class Parser {
  tokens: Token[];
  pos: number;
  depth: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
    this.depth = 0;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const t = this.tokens[this.pos++];
    if (t === undefined) {
      throw new ExpressionEvaluatorError("Unexpected end of expression.");
    }
    return t;
  }

  private expect(type: TokenType, raw?: string): Token {
    const t = this.consume();
    if (t.type !== type || (raw !== undefined && t.raw !== raw)) {
      throw new ExpressionEvaluatorError(
        `Expected ${raw ?? type} but got "${t.raw}".`,
      );
    }
    return t;
  }

  parseExpression(minPower: number): AstNode {
    this.depth++;
    if (this.depth > 50) {
      throw new ExpressionEvaluatorError("Expression exceeds maximum nesting depth (50).");
    }

    let left = this.parseUnary();

    while (true) {
      const t = this.peek();
      if (t === undefined || t.type !== "OP") break;
      const power = INFIX_POWER[t.raw];
      if (power === undefined || power <= minPower) break;
      this.consume();
      const right = this.parseExpression(power);
      left = { kind: "binary", op: t.raw, left, right };
    }

    this.depth--;
    return left;
  }

  private parseUnary(): AstNode {
    const t = this.peek();
    if (t?.type === "OP" && (t.raw === "!" || t.raw === "-")) {
      this.consume();
      const operand = this.parseUnary();
      return { kind: "unary", op: t.raw, operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    const t = this.peek();
    if (t === undefined) {
      throw new ExpressionEvaluatorError("Unexpected end of expression.");
    }

    if (t.type === "NUMBER" || t.type === "STRING" || t.type === "BOOL") {
      this.consume();
      return { kind: "literal", value: t.value };
    }

    if (t.type === "NULL") {
      this.consume();
      return { kind: "literal", value: null };
    }

    if (t.type === "LPAREN") {
      this.consume();
      const inner = this.parseExpression(0);
      this.expect("RPAREN");
      return inner;
    }

    if (t.type === "IDENT") {
      this.consume();
      const name = t.raw;

      // Check for function call
      if (this.peek()?.type === "LPAREN") {
        this.consume(); // '('
        const args: AstNode[] = [];
        while (this.peek()?.type !== "RPAREN") {
          args.push(this.parseExpression(0));
          if (this.peek()?.type === "COMMA") this.consume();
        }
        this.expect("RPAREN");
        return { kind: "call", name, args };
      }

      // Field path: ident(.ident)*
      const path: string[] = [name];
      while (this.peek()?.type === "DOT") {
        this.consume(); // '.'
        const field = this.consume();
        if (field.type !== "IDENT") {
          throw new ExpressionEvaluatorError(
            `Expected field name after '.', got "${field.raw}".`,
          );
        }
        path.push(field.raw);
      }
      return { kind: "field", path };
    }

    throw new ExpressionEvaluatorError(
      `Unexpected token "${t.raw}" (type=${t.type}).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

// Built-in function type alias — every built-in receives spread unknown args
// and returns unknown so the evaluator can call them uniformly.
type BuiltinFn = (...args: unknown[]) => unknown;

// Built-in function implementations — all pure, no I/O
const BUILTINS: Record<string, BuiltinFn> = {
  startsWith: (s: unknown, prefix: unknown) =>
    typeof s === "string" && typeof prefix === "string" && s.startsWith(prefix),
  endsWith: (s: unknown, suffix: unknown) =>
    typeof s === "string" && typeof suffix === "string" && s.endsWith(suffix),
  includes: (s: unknown, sub: unknown) =>
    typeof s === "string" && typeof sub === "string" && s.includes(sub),
  toLowerCase: (s: unknown) =>
    typeof s === "string" ? s.toLowerCase() : s,
  toUpperCase: (s: unknown) =>
    typeof s === "string" ? s.toUpperCase() : s,
  trim: (s: unknown) =>
    typeof s === "string" ? s.trim() : s,
  length: (s: unknown) =>
    typeof s === "string" ? s.length : Array.isArray(s) ? s.length : null,
  toString: (v: unknown) =>
    v === null || v === undefined ? "" : String(v),
  toNumber: (v: unknown) => {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  },
  isNull: (v: unknown) => v === null || v === undefined,
  isNotNull: (v: unknown) => v !== null && v !== undefined,
  concat: (...args: unknown[]) => args.map((a) => (a === null || a === undefined ? "" : String(a))).join(""),
  round: (v: unknown, digits: unknown) => {
    if (typeof v !== "number") return null;
    const d = typeof digits === "number" ? digits : 0;
    const factor = Math.pow(10, d);
    return Math.round(v * factor) / factor;
  },
  floor: (v: unknown) => (typeof v === "number" ? Math.floor(v) : null),
  ceil: (v: unknown) => (typeof v === "number" ? Math.ceil(v) : null),
  abs: (v: unknown) => (typeof v === "number" ? Math.abs(v) : null),
  coalesce: (...args: unknown[]) => args.find((a) => a !== null && a !== undefined) ?? null,
};

function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  return true;
}

function resolveField(path: string[], ctx: EvalContext): unknown {
  let current: unknown = ctx.record;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function evalNode(node: AstNode, ctx: EvalContext, depth: number): unknown {
  if (depth > 100) {
    throw new ExpressionEvaluatorError("Expression evaluation depth limit exceeded.");
  }

  switch (node.kind) {
    case "literal":
      return node.value;

    case "field":
      return resolveField(node.path, ctx);

    case "unary": {
      const operand = evalNode(node.operand, ctx, depth + 1);
      if (node.op === "!") return !isTruthy(operand);
      if (node.op === "-") {
        if (typeof operand === "number") return -operand;
        throw new ExpressionEvaluatorError(
          `Unary '-' applied to non-number value: ${JSON.stringify(operand)}`,
        );
      }
      throw new ExpressionEvaluatorError(`Unknown unary operator "${node.op}".`);
    }

    case "binary": {
      // Short-circuit logical operators before evaluating right side
      if (node.op === "&&") {
        const l = evalNode(node.left, ctx, depth + 1);
        if (!isTruthy(l)) return false;
        return isTruthy(evalNode(node.right, ctx, depth + 1));
      }
      if (node.op === "||") {
        const l = evalNode(node.left, ctx, depth + 1);
        if (isTruthy(l)) return true;
        return isTruthy(evalNode(node.right, ctx, depth + 1));
      }

      const left = evalNode(node.left, ctx, depth + 1);
      const right = evalNode(node.right, ctx, depth + 1);

      switch (node.op) {
        case "==": return left === right;
        case "!=": return left !== right;
        case "<":  return toNum(left, "<") < toNum(right, "<");
        case "<=": return toNum(left, "<=") <= toNum(right, "<=");
        case ">":  return toNum(left, ">") > toNum(right, ">");
        case ">=": return toNum(left, ">=") >= toNum(right, ">=");
        case "+": {
          if (typeof left === "string" || typeof right === "string") {
            return String(left ?? "") + String(right ?? "");
          }
          return toNum(left, "+") + toNum(right, "+");
        }
        case "-": return toNum(left, "-") - toNum(right, "-");
        case "*": return toNum(left, "*") * toNum(right, "*");
        case "/": {
          const divisor = toNum(right, "/");
          if (divisor === 0) throw new ExpressionEvaluatorError("Division by zero.");
          return toNum(left, "/") / divisor;
        }
        case "%": {
          const divisor = toNum(right, "%");
          if (divisor === 0) throw new ExpressionEvaluatorError("Modulo by zero.");
          return toNum(left, "%") % divisor;
        }
        default:
          throw new ExpressionEvaluatorError(`Unknown binary operator "${node.op}".`);
      }
    }

    case "call": {
      const fn = BUILTINS[node.name];
      if (fn === undefined) {
        throw new ExpressionEvaluatorError(
          `Unknown function "${node.name}". Available: ${Object.keys(BUILTINS).join(", ")}.`,
        );
      }
      const args = node.args.map((a) => evalNode(a, ctx, depth + 1));
      return fn(...args);
    }
  }
}

function toNum(v: unknown, op: string): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  throw new ExpressionEvaluatorError(
    `Operator "${op}" requires numeric operands, got: ${JSON.stringify(v)}`,
  );
}
