#!/usr/bin/env node
/**
 * @oneplatform/cli — OnePlatform CLI (op)
 *
 * Entry point: builds the Commander.js program with all 20 command groups,
 * then parses process.argv.
 *
 * Each command group is independently importable and testable.
 * Global flags are resolved via the preAction hook before any command runs.
 */
import { Command } from "commander";
import { globalPreActionHook } from "./lib/context.js";
import { CLI_VERSION } from "./commands/version/index.js";

import { registerAuth } from "./commands/auth/index.js";
import { registerProfile } from "./commands/profile/index.js";
import { registerUser } from "./commands/user/index.js";
import { registerRole } from "./commands/role/index.js";
import { registerOntology } from "./commands/ontology/index.js";
import { registerData } from "./commands/data/index.js";
import { registerConnector } from "./commands/connector/index.js";
import { registerMapping } from "./commands/mapping/index.js";
import { registerWebhookOut } from "./commands/webhook-out/index.js";
import { registerPipeline } from "./commands/pipeline/index.js";
import { registerSchedule } from "./commands/schedule/index.js";
import { registerDlq } from "./commands/dlq/index.js";
import { registerExec } from "./commands/exec/index.js";
import { registerApp } from "./commands/app/index.js";
import { registerPlugin } from "./commands/plugin/index.js";
import { registerLogs } from "./commands/logs/index.js";
import { registerConfig } from "./commands/config/index.js";
import { registerStatus } from "./commands/status/index.js";
import { registerService } from "./commands/service/index.js";
import { registerSdk } from "./commands/sdk/index.js";
import { registerVersion } from "./commands/version/index.js";
import { registerCompletion } from "./commands/completion/index.js";

/**
 * Constructs and returns the configured Commander program.
 * Exported for use by docs-generator and tests.
 */
export function buildProgram(): Command {
  const program = new Command("op")
    .version(CLI_VERSION, "-V, --version", "Print CLI version")
    .description("OnePlatform CLI — interact with every platform feature from the terminal")
    .addHelpText("after", "\nRun 'op <group> --help' for group-level help.")
    // Global flags — visible on every command via .optsWithGlobals()
    .option("--profile <name>", "Credential profile to use (env: OP_PROFILE)")
    .option("-o, --output <fmt>", "Output format: table|json|jsonl|tsv (env: OP_OUTPUT)")
    .option("-y, --yes", "Skip destructive-action confirmations")
    .option("-q, --quiet", "Suppress all output except errors")
    .option("--no-color", "Disable ANSI colors (env: NO_COLOR)")
    .option("-v, --verbose", "Print stack traces, HTTP request details (env: OP_VERBOSE)")
    .option("--timeout <ms>", "HTTP request timeout in milliseconds (env: OP_TIMEOUT)")
    .option("--platform <url>", "Override platform URL (env: OP_PLATFORM_URL)")
    .hook("preAction", globalPreActionHook);

  // 21 command groups registered in spec order
  registerAuth(program);
  registerProfile(program);
  registerUser(program);
  registerRole(program);
  registerOntology(program);
  registerData(program);
  registerConnector(program);
  registerMapping(program);
  registerWebhookOut(program);
  registerPipeline(program);
  registerSchedule(program);
  registerDlq(program);
  registerExec(program);
  registerApp(program);
  registerPlugin(program);
  registerLogs(program);
  registerConfig(program);
  registerStatus(program);
  registerService(program);
  registerSdk(program);
  registerVersion(program);
  registerCompletion(program);

  return program;
}

// Parse argv when invoked as the CLI binary
const program = buildProgram();
program.parse(process.argv);
