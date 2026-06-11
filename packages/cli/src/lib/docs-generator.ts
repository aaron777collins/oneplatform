/**
 * Generates man-page-style Markdown CLI reference from Commander.js command definitions.
 * Run via: npx tsx src/lib/docs-generator.ts
 * Output is written to docs/generated/cli/.
 *
 * This is the source of /docs/cli in the platform UI (ADR-23).
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

export function generateDocs(program: Command, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });

  let index = `# OnePlatform CLI Reference\n\nGenerated from \`op --help\` on ${new Date().toISOString()}\n\n`;
  index += `## Command Groups\n\n`;

  for (const group of program.commands) {
    const groupName = group.name();
    index += `- [\`op ${groupName}\`](./${groupName}.md)\n`;

    const groupMd =
      `# \`op ${groupName}\`\n\n${group.description()}\n\n` +
      group.commands.map((c) => commandToMarkdown(c, 2)).join("\n---\n\n");

    writeFileSync(join(outputDir, `${groupName}.md`), groupMd, "utf8");
  }

  writeFileSync(join(outputDir, "index.md"), index, "utf8");
}

// When run directly as a script
if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].endsWith("docs-generator.ts")
) {
  const { buildProgram } = await import("../index.js");
  const prog = buildProgram();
  const outputDir = join(process.cwd(), "../../docs/generated/cli");
  generateDocs(prog, outputDir);
  process.stdout.write(`Docs generated in ${outputDir}\n`);
}
