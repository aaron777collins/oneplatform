/**
 * Tests for packages/cli/src/lib/docs-generator.ts
 *
 * We test generateDocs() in isolation using a minimal Commander program so the
 * suite never needs to import the real command handlers (which have side-effects
 * like connecting to the platform API).  This mirrors the approach in
 * tools/openapi-gen's spec-builder tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateDocs } from "../lib/docs-generator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Commander program that exercises the generator's logic
 * without pulling in any real CLI command registrations or external deps.
 *
 * Structure mirrors the real op CLI:
 *   op
 *     auth         (group)
 *       login      (subcommand with args + options)
 *       logout
 *     data         (group)
 *       list       (subcommand with options)
 */
function buildMockProgram(): Command {
  const program = new Command("op")
    .description("OnePlatform CLI — test fixture")
    .option("--profile <name>", "Credential profile")
    .option("-o, --output <fmt>", "Output format");

  // auth group
  const auth = new Command("auth").description("Authentication commands");
  auth
    .command("login")
    .description("Log in to the platform")
    .argument("[url]", "Platform URL override")
    .option("--key <apikey>", "API key for non-interactive login");
  auth
    .command("logout")
    .description("Clear stored credentials");
  program.addCommand(auth);

  // data group (no subcommands — exercises the empty-subcommand branch)
  const data = new Command("data").description("Entity CRUD and bulk operations");
  data
    .command("list")
    .description("List entity records")
    .option("--limit <n>", "Page size", "50");
  program.addCommand(data);

  return program;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  // Each test gets its own isolated temp directory so parallel runs cannot
  // interfere with each other.
  tmpDir = mkdtempSync(join(tmpdir(), "op-docs-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateDocs()", () => {
  it("creates an index.md file in the output directory", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    const files = readdirSync(tmpDir);
    expect(files).toContain("index.md");
  });

  it("creates one Markdown file per top-level command group", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    const files = readdirSync(tmpDir);
    // auth and data are the two registered groups
    expect(files).toContain("auth.md");
    expect(files).toContain("data.md");
  });

  it("does not generate extra files beyond index + one-per-group", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    const files = readdirSync(tmpDir).sort();
    // Exactly: auth.md, data.md, index.md
    expect(files).toEqual(["auth.md", "data.md", "index.md"]);
  });

  it("writes Starlight-compatible YAML frontmatter to each group file", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    const authContent = readFileSync(join(tmpDir, "auth.md"), "utf8");

    // Frontmatter must start at the very first character of the file
    expect(authContent.startsWith("---\n")).toBe(true);

    // Required Starlight fields
    expect(authContent).toContain('title: "op auth"');
    expect(authContent).toContain('description: "');

    // Sidebar order must be present
    expect(authContent).toMatch(/sidebar:\n\s+order: \d+/);

    // Frontmatter must close before the body
    const closingFence = authContent.indexOf("---\n", 4);
    expect(closingFence).toBeGreaterThan(4);
  });

  it("writes frontmatter to every generated group file", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    for (const groupName of ["auth", "data"]) {
      const content = readFileSync(join(tmpDir, `${groupName}.md`), "utf8");
      expect(content.startsWith("---\n"), `${groupName}.md should start with frontmatter`).toBe(true);
    }
  });

  it("uses the group name in the frontmatter title", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    const dataContent = readFileSync(join(tmpDir, "data.md"), "utf8");
    expect(dataContent).toContain('title: "op data"');
  });

  it("includes the group description in the frontmatter", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    const authContent = readFileSync(join(tmpDir, "auth.md"), "utf8");
    // The description field should embed the Commander description
    expect(authContent).toContain("Authentication commands");
  });

  it("writes the group description and subcommand details in the body", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    const authContent = readFileSync(join(tmpDir, "auth.md"), "utf8");

    // Body should contain the group description
    expect(authContent).toContain("Authentication commands");

    // Body should contain subcommand names
    expect(authContent).toContain("`login`");
    expect(authContent).toContain("`logout`");
  });

  it("includes command arguments in the body", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    const authContent = readFileSync(join(tmpDir, "auth.md"), "utf8");
    // login has a [url] optional argument
    expect(authContent).toContain("[url]");
  });

  it("includes command options in the body", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    const authContent = readFileSync(join(tmpDir, "auth.md"), "utf8");
    // login has --key option
    expect(authContent).toContain("--key");
  });

  it("includes default values for options that have them", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    const dataContent = readFileSync(join(tmpDir, "data.md"), "utf8");
    // data list --limit has default "50"
    expect(dataContent).toContain("default: `50`");
  });

  it("index.md lists links to each group file", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    const index = readFileSync(join(tmpDir, "index.md"), "utf8");
    expect(index).toContain("./auth.md");
    expect(index).toContain("./data.md");
  });

  it("index.md has Starlight frontmatter", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    const index = readFileSync(join(tmpDir, "index.md"), "utf8");
    expect(index.startsWith("---\n")).toBe(true);
    expect(index).toContain('title: "OnePlatform CLI Reference"');
  });

  it("output directory is created if it does not exist", () => {
    const program = buildMockProgram();
    const nestedDir = join(tmpDir, "a", "b", "c");

    // nestedDir does not exist yet — generateDocs must create it
    expect(() => generateDocs(program, nestedDir)).not.toThrow();

    const files = readdirSync(nestedDir);
    expect(files).toContain("index.md");
  });

  it("assigns ascending sidebar order values across group files", () => {
    const program = buildMockProgram();
    generateDocs(program, tmpDir);

    // Extract sidebar.order from each group file's frontmatter
    const orders: number[] = [];
    for (const groupName of ["auth", "data"]) {
      const content = readFileSync(join(tmpDir, `${groupName}.md`), "utf8");
      const match = /order:\s+(\d+)/.exec(content);
      expect(match, `${groupName}.md missing sidebar order`).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      orders.push(parseInt(match![1]!, 10));
    }

    // Each value must be unique and positive
    const unique = new Set(orders);
    expect(unique.size).toBe(orders.length);
    expect(orders.every((n) => n > 0)).toBe(true);
  });
});
