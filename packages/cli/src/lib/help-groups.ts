/**
 * help-groups.ts — Command group definitions for `op --help` output.
 *
 * Commander.js does not natively support grouping commands under named category
 * headers. This module defines the authoritative group taxonomy and produces
 * the formatted block that is injected via `.addHelpText("after", ...)` in the
 * program builder.
 *
 * Keeping the grouping data separate from index.ts lets the test suite import
 * it directly and assert on structure without building the entire program.
 */

/** One command entry inside a group. */
export interface GroupCommand {
  /** The command name as registered with Commander (e.g. "webhook-out"). */
  name: string;
  /** One-line description shown next to the command name in help output. */
  description: string;
}

/** A logical category shown as a header in the help output. */
export interface CommandGroup {
  /** Category header printed in help (e.g. "Data Integration"). */
  header: string;
  /** One-line summary of what the group covers, printed below the header. */
  summary: string;
  /** Ordered list of commands belonging to this group. */
  commands: GroupCommand[];
}

/**
 * The canonical group taxonomy for the OnePlatform CLI.
 *
 * Order here controls the order sections appear in `op --help`. Commands that
 * don't fit a named group (completion, version) appear in a catch-all section
 * at the end so they don't pollute the primary workflow sections.
 */
export const COMMAND_GROUPS: CommandGroup[] = [
  {
    header: "Data Integration",
    summary: "Connect to external systems and control how data flows into the platform",
    commands: [
      { name: "connector", description: "Connector lifecycle management" },
      { name: "mapping",   description: "Field mapping rules between connectors and entity types" },
      { name: "schedule",  description: "Cron schedule management for automated sync runs" },
      { name: "data",      description: "Entity CRUD and bulk import/export operations" },
      { name: "webhook-out", description: "Outbound webhook subscriptions" },
    ],
  },
  {
    header: "Data Modeling",
    summary: "Define and evolve entity type schemas",
    commands: [
      { name: "ontology", description: "Manage entity type schemas, migrations, and exports" },
    ],
  },
  {
    header: "Automation",
    summary: "Build, trigger, and monitor data processing pipelines",
    commands: [
      { name: "pipeline", description: "Pipeline definitions and runs" },
      { name: "exec",     description: "Ad-hoc code execution in the platform sandbox" },
      { name: "dlq",     description: "Dead-letter queue inspection and replay" },
    ],
  },
  {
    header: "Applications",
    summary: "Deploy and operate embedded apps on the platform",
    commands: [
      { name: "app", description: "App deployment, dev server, logs, and environment management" },
    ],
  },
  {
    header: "Extensions",
    summary: "Package and manage plugins that extend platform behaviour",
    commands: [
      { name: "plugin", description: "Plugin lifecycle — install, pack, simulate, and dev server" },
    ],
  },
  {
    header: "Identity & Access",
    summary: "Authenticate, manage users, roles, and API credentials",
    commands: [
      { name: "auth",    description: "Log in, log out, and manage API keys" },
      { name: "profile", description: "Multi-environment profile management" },
      { name: "user",    description: "User management (scope: users:manage)" },
      { name: "role",    description: "Role assignment (scope: users:manage)" },
    ],
  },
  {
    header: "Administration",
    summary: "Observe, configure, and operate the platform itself",
    commands: [
      { name: "config",  description: "Export, import, diff, and validate platform configuration" },
      { name: "status",  description: "Platform health overview with optional watch mode" },
      { name: "logs",    description: "Log and audit trail queries (scope: admin)" },
      { name: "service", description: "Service administration — restart, scale, rotate keys" },
      { name: "sdk",     description: "SDK and type-declaration code generation" },
    ],
  },
  {
    header: "Tooling",
    summary: "Shell completions and version information",
    commands: [
      { name: "version",    description: "Print CLI and platform version information" },
      { name: "completion", description: "Generate shell completion scripts (bash, zsh, fish)" },
    ],
  },
];

/**
 * Common workflows shown in the Examples section at the bottom of `op --help`.
 * These are representative end-to-end sequences, not exhaustive command lists.
 */
export const HELP_EXAMPLES = [
  {
    label: "First-time setup",
    steps: [
      "op profile add prod --platform https://api.example.com",
      "op auth login --profile prod",
    ],
  },
  {
    label: "Ingest data from a connector",
    steps: [
      "op connector create --plugin com.acme.salesforce --name my-salesforce",
      "op connector trigger <id> --wait",
    ],
  },
  {
    label: "Run and monitor a pipeline",
    steps: [
      "op pipeline trigger <pipeline-id> --input '{\"env\":\"prod\"}'",
      "op pipeline run-logs <run-id> --follow",
    ],
  },
  {
    label: "Deploy an app",
    steps: [
      "op app init --name my-dashboard",
      "op app create --name my-dashboard --slug my-dashboard",
      "op app deploy my-dashboard --file dist/bundle.tar.gz --wait",
    ],
  },
  {
    label: "Develop and publish a plugin",
    steps: [
      "op plugin create",
      "op plugin dev --watch",
      "op plugin pack",
      "op plugin install ./my-plugin.oppkg",
    ],
  },
];

/**
 * Builds the formatted after-help text block injected into `op --help`.
 *
 * The output uses two-space indented columns aligned to a fixed width so that
 * command names and descriptions line up regardless of terminal width. This
 * mirrors the style Commander uses for its built-in options block.
 */
export function buildGroupedHelpText(): string {
  const NAME_COL_WIDTH = 14; // wide enough for "webhook-out" + padding
  const lines: string[] = ["", "Command Groups:"];

  for (const group of COMMAND_GROUPS) {
    lines.push("");
    lines.push(`  ${group.header}`);
    lines.push(`    ${group.summary}`);
    lines.push("");
    for (const cmd of group.commands) {
      const padded = cmd.name.padEnd(NAME_COL_WIDTH);
      lines.push(`    ${padded}  ${cmd.description}`);
    }
  }

  lines.push("");
  lines.push("Examples:");

  for (const example of HELP_EXAMPLES) {
    lines.push("");
    lines.push(`  # ${example.label}`);
    for (const step of example.steps) {
      lines.push(`  ${step}`);
    }
  }

  lines.push("");
  lines.push("Run 'op <command> --help' for command-specific help.");

  return lines.join("\n");
}
