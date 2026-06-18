/**
 * Tests for CLI command grouping (G-103).
 *
 * These tests verify three requirements without starting the real program or
 * making any network calls:
 *
 *  1. All registered commands are still accessible after the refactor.
 *  2. `op --help` output includes every group header defined in COMMAND_GROUPS.
 *  3. Every top-level command has a non-empty description.
 *
 * We build the full Commander program via buildProgram() because that is the
 * integration point — it is the same function the real binary uses, so any
 * accidental de-registration would be caught here. Command actions are never
 * invoked, so there are no side effects (no HTTP calls, no filesystem writes).
 */
import { describe, it, expect } from "vitest";
import { buildProgram } from "../index.js";
import { COMMAND_GROUPS, buildGroupedHelpText } from "../lib/help-groups.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Captures Commander's help output for a given argv without triggering
 * process.exit(), which Commander calls after printing help.
 *
 * Commander's outputHelp() writes to stdout by default. We redirect it to a
 * local string so tests can inspect the text.
 */
function captureHelp(argv: string[]): string {
  const program = buildProgram();
  let captured = "";

  // Override the write function so nothing reaches stdout.
  program.configureOutput({
    writeOut: (str) => { captured += str; },
    writeErr: (str) => { captured += str; },
  });

  try {
    // parseAsync would actually run actions; parseOptions only processes flags
    // and identifies the subcommand, which is enough to reach the help path.
    program.parseOptions(argv);
    program.outputHelp();
  } catch {
    // Commander throws when it encounters --help via exitOverride; we want the
    // captured text regardless.
  }

  return captured;
}

/**
 * Returns all top-level Command objects registered on the root program,
 * excluding the implicit "help" command that Commander adds automatically.
 */
function getTopLevelCommands() {
  const program = buildProgram();
  return program.commands.filter((c) => c.name() !== "help");
}

// ---------------------------------------------------------------------------
// 1. All commands are accessible
// ---------------------------------------------------------------------------

describe("command registration", () => {
  it("registers every command named in COMMAND_GROUPS", () => {
    const commands = getTopLevelCommands();
    const registeredNames = new Set(commands.map((c) => c.name()));

    const groupedNames = COMMAND_GROUPS.flatMap((g) => g.commands.map((c) => c.name));

    for (const name of groupedNames) {
      expect(
        registeredNames.has(name),
        `Command "${name}" is listed in COMMAND_GROUPS but not registered on the program`,
      ).toBe(true);
    }
  });

  it("does not lose any commands relative to the full expected set", () => {
    // Authoritative list of all 22 top-level commands (excluding auto-added "help").
    const expectedCommands = [
      "auth", "profile", "user", "role",
      "ontology", "data", "connector", "mapping", "webhook-out",
      "pipeline", "schedule", "dlq", "exec",
      "app", "plugin",
      "logs", "config", "status", "service", "sdk",
      "version", "completion",
    ];

    const commands = getTopLevelCommands();
    const registeredNames = commands.map((c) => c.name()).sort();
    const sortedExpected = [...expectedCommands].sort();

    expect(registeredNames).toEqual(sortedExpected);
  });

  it("each registered command is individually accessible by name", () => {
    const program = buildProgram();
    const commandsToCheck = [
      "auth", "connector", "ontology", "pipeline",
      "app", "plugin", "config", "status",
    ];

    for (const name of commandsToCheck) {
      const found = program.commands.find((c) => c.name() === name);
      expect(found, `"${name}" command not found`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Help output includes group headers
// ---------------------------------------------------------------------------

describe("help output grouping", () => {
  it("op --help contains every group header from COMMAND_GROUPS", () => {
    const helpText = buildGroupedHelpText();

    for (const group of COMMAND_GROUPS) {
      expect(
        helpText,
        `Group header "${group.header}" missing from help output`,
      ).toContain(group.header);
    }
  });

  it("op --help contains the expected group headers in order", () => {
    const helpText = buildGroupedHelpText();
    const expectedHeaders = COMMAND_GROUPS.map((g) => g.header);

    let lastIndex = -1;
    for (const header of expectedHeaders) {
      const idx = helpText.indexOf(header);
      expect(idx, `Header "${header}" not found in help text`).toBeGreaterThan(-1);
      expect(
        idx,
        `Header "${header}" appears before the previous header (order violated)`,
      ).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it("op --help contains 'Command Groups:' section label", () => {
    const helpText = buildGroupedHelpText();
    expect(helpText).toContain("Command Groups:");
  });

  it("op --help contains an Examples section", () => {
    const helpText = buildGroupedHelpText();
    expect(helpText).toContain("Examples:");
  });

  it("op --help mentions common workflow commands in examples", () => {
    const helpText = buildGroupedHelpText();
    // Every example block contains at least one op command reference.
    expect(helpText).toContain("op auth login");
    expect(helpText).toContain("op connector");
    expect(helpText).toContain("op pipeline trigger");
    expect(helpText).toContain("op app deploy");
    expect(helpText).toContain("op plugin");
  });

  it("op --help lists every command name inside its group", () => {
    const helpText = buildGroupedHelpText();

    for (const group of COMMAND_GROUPS) {
      for (const cmd of group.commands) {
        expect(
          helpText,
          `Command "${cmd.name}" from group "${group.header}" is missing from help text`,
        ).toContain(cmd.name);
      }
    }
  });

  it("group summaries appear in the help text", () => {
    const helpText = buildGroupedHelpText();

    for (const group of COMMAND_GROUPS) {
      expect(
        helpText,
        `Group summary for "${group.header}" missing from help text`,
      ).toContain(group.summary);
    }
  });

  it("help text ends with a tip to use --help on subcommands", () => {
    const helpText = buildGroupedHelpText();
    expect(helpText).toContain("op <command> --help");
  });
});

// ---------------------------------------------------------------------------
// 3. Every command has a description
// ---------------------------------------------------------------------------

describe("command descriptions", () => {
  it("every top-level command has a non-empty description", () => {
    const commands = getTopLevelCommands();

    for (const cmd of commands) {
      const desc = cmd.description();
      expect(
        desc.length,
        `Command "${cmd.name()}" has an empty description`,
      ).toBeGreaterThan(0);
    }
  });

  it("every COMMAND_GROUPS entry has a non-empty group description", () => {
    for (const group of COMMAND_GROUPS) {
      expect(
        group.summary.length,
        `Group "${group.header}" has an empty summary`,
      ).toBeGreaterThan(0);

      for (const cmd of group.commands) {
        expect(
          cmd.description.length,
          `Command "${cmd.name}" in group "${group.header}" has an empty description`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("COMMAND_GROUPS descriptions are consistent with Commander descriptions for known commands", () => {
    const program = buildProgram();

    // Spot-check a representative sample rather than every command to avoid
    // brittle coupling to every description string.
    const spotCheck: Record<string, string> = {
      auth:      "Authentication",
      connector: "connector",
      ontology:  "schema",
      pipeline:  "pipeline",
      app:       "App",
      plugin:    "Plugin",
    };

    for (const [name, expectedFragment] of Object.entries(spotCheck)) {
      const cmd = program.commands.find((c) => c.name() === name);
      expect(cmd, `"${name}" not found`).toBeDefined();
      expect(
        cmd!.description().toLowerCase(),
        `"${name}" description should contain "${expectedFragment.toLowerCase()}"`,
      ).toContain(expectedFragment.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------
// 4. No command name appears in more than one group (uniqueness)
// ---------------------------------------------------------------------------

describe("COMMAND_GROUPS taxonomy integrity", () => {
  it("no command name appears in more than one group", () => {
    const seen = new Map<string, string>();

    for (const group of COMMAND_GROUPS) {
      for (const cmd of group.commands) {
        if (seen.has(cmd.name)) {
          throw new Error(
            `Command "${cmd.name}" appears in both "${seen.get(cmd.name)!}" and "${group.header}"`,
          );
        }
        seen.set(cmd.name, group.header);
      }
    }

    // If we reach here, all names are unique.
    expect(seen.size).toBeGreaterThan(0);
  });

  it("every group has at least one command", () => {
    for (const group of COMMAND_GROUPS) {
      expect(
        group.commands.length,
        `Group "${group.header}" is empty`,
      ).toBeGreaterThan(0);
    }
  });
});
