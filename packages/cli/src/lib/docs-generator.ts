/**
 * Generates man-page-style Markdown CLI reference from Commander.js command definitions.
 *
 * Each per-group file has Starlight-compatible YAML frontmatter so the docs site
 * can pick it up without any additional configuration (ADR-23, design doc §5).
 *
 * Run via:
 *   npx tsx src/lib/docs-generator.ts --out dist/docs
 *
 * Output stays inside packages/cli/dist/docs/ (within the package boundary) so
 * Turbo can cache it correctly.  The root docs:merge step then copies it to
 * docs/generated/cli/.  See tools/scripts/docs-merge.mjs.
 */
import type { Command, Option, Argument } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function optionToMarkdown(opt: Option): string {
  const flags = opt.flags;
  const desc = opt.description;
  const def = opt.defaultValue !== undefined ? ` (default: \`${String(opt.defaultValue)}\`)` : "";
  return `- \`${flags}\` — ${desc}${def}`;
}

function argumentToMarkdown(arg: Argument): string {
  const req = arg.required ? `<${arg.name()}>` : `[${arg.name()}]`;
  return `- \`${req}\` — ${arg.description ?? ""}`;
}

function commandToMarkdown(cmd: Command, depth: number): string {
  const prefix = "#".repeat(Math.min(depth + 1, 4));
  const name = cmd.name();
  const desc = cmd.description();
  const usage = cmd.usage();

  let md = `${prefix} \`${name}\`\n\n`;
  if (desc) md += `${desc}\n\n`;
  md += `**Usage:** \`${name} ${usage}\`\n\n`;

  const args = cmd.registeredArguments;
  if (args.length > 0) {
    md += `**Arguments:**\n\n`;
    for (const arg of args) {
      md += `${argumentToMarkdown(arg)}\n`;
    }
    md += "\n";
  }

  const opts = cmd.options;
  if (opts.length > 0) {
    md += `**Options:**\n\n`;
    for (const opt of opts) {
      md += `${optionToMarkdown(opt)}\n`;
    }
    md += "\n";
  }

  const subcommands = cmd.commands;
  if (subcommands.length > 0) {
    for (const sub of subcommands) {
      md += commandToMarkdown(sub, depth + 1);
    }
  }

  return md;
}

/**
 * Builds YAML frontmatter for a command group page.
 *
 * Starlight reads `title` and `description` from the frontmatter block to
 * populate the sidebar label and the meta description tag.  The `sidebar.order`
 * field controls the ordering within the CLI Reference section.
 */
function buildFrontmatter(groupName: string, description: string, order: number): string {
  // Escape double-quotes in description so the YAML string remains valid.
  const safeDesc = description.replace(/"/g, '\\"');
  return [
    "---",
    `title: "op ${groupName}"`,
    `description: "${safeDesc}"`,
    "sidebar:",
    `  order: ${order}`,
    "---",
    "",
    "",
  ].join("\n");
}

export function generateDocs(program: Command, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });

  // index.md: lightweight TOC that Starlight renders as the CLI section landing page.
  let index = `---\ntitle: "OnePlatform CLI Reference"\ndescription: "Complete reference for the op command-line interface"\nsidebar:\n  order: 0\n---\n\n`;
  index += `# OnePlatform CLI Reference\n\nGenerated from \`op --help\` on ${new Date().toISOString()}\n\n`;
  index += `## Command Groups\n\n`;

  for (const [idx, group] of program.commands.entries()) {
    const groupName = group.name();
    const groupDesc = group.description() || `CLI reference for op ${groupName} commands`;

    index += `- [\`op ${groupName}\`](./${groupName}.md)\n`;

    // Per-group page: frontmatter + group-level description + per-subcommand sections.
    const frontmatter = buildFrontmatter(groupName, groupDesc, idx + 1);
    const body =
      `# \`op ${groupName}\`\n\n${groupDesc}\n\n` +
      group.commands.map((c) => commandToMarkdown(c, 2)).join("\n---\n\n");

    writeFileSync(join(outputDir, `${groupName}.md`), frontmatter + body, "utf8");
  }

  writeFileSync(join(outputDir, "index.md"), index, "utf8");
}

/**
 * Parse --out <dir> from argv.  Returns the value after --out, or null if the
 * flag is not present.  Commander is not used here to avoid a circular import
 * (this file is imported by buildProgram via tests).
 */
function parseOutFlag(argv: string[]): string | null {
  const idx = argv.indexOf("--out");
  if (idx !== -1 && idx + 1 < argv.length) {
    const value = argv[idx + 1];
    // Guard against accidental flag-as-value (e.g. --out --something)
    if (value !== undefined && !value.startsWith("-")) {
      return value;
    }
  }
  return null;
}

// When run directly as a script (tsx src/lib/docs-generator.ts --out <dir>)
if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].endsWith("docs-generator.ts")
) {
  const outFlag = parseOutFlag(process.argv);
  // Default to dist/docs so the output stays within the package boundary and
  // Turbo can cache it.  The old default (../../docs/generated/cli) violated
  // Turbo's package-boundary constraint — see design doc §7.
  const outputDir = outFlag ?? join(process.cwd(), "dist/docs");

  const { buildProgram } = await import("../index.js");
  const prog = buildProgram();
  generateDocs(prog, outputDir);
  process.stdout.write(`Docs generated in ${outputDir}\n`);
}
