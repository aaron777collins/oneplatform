// ---------------------------------------------------------------------------
// Template literal escape helper — P19-010
//
// User-supplied strings (appName, slug) must NOT be interpolated raw into
// generated TSX source because the generated source itself lives inside JS
// backtick template literals in this file. A malicious name containing a
// backtick, a backslash, or `${` can break out of the string context and
// inject arbitrary code into the generated file.
//
// This helper escapes exactly the three sequences that are meaningful inside
// a JS/TS backtick template literal: `\`, `` ` ``, and `${`.
// ---------------------------------------------------------------------------

export function escapeForTemplateLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")   // backslash must be first to avoid double-escaping
    .replace(/`/g, "\\`")     // backtick would close the outer template literal
    .replace(/\$\{/g, "\\${"); // ${ would start an interpolation expression
}
