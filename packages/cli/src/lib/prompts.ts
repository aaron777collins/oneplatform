/**
 * inquirer.js wrappers with --yes bypass support.
 * Prompts only render when stdin is a TTY. Non-TTY + no --yes exits with an error.
 */
import { input, confirm, password, select } from "@inquirer/prompts";
import { CliError, EXIT } from "./errors.js";

/** Standard confirmation for destructive operations. */
export async function confirmDestructive(
  message: string,
  yes: boolean,
): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new CliError(
      `${message}\nRun with --yes to confirm in non-interactive mode.`,
      EXIT.GENERAL,
    );
  }
  const confirmed = await confirm({ message, default: false });
  if (!confirmed) {
    throw new CliError("Aborted.", EXIT.OK);
  }
}

/**
 * Special confirmation that requires typing a specific word.
 * Used for emergency-rotate — exempt from --yes bypass.
 */
export async function confirmByTyping(
  message: string,
  requiredWord: string,
): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new CliError(
      `This command requires interactive confirmation. Run it in a terminal.`,
      EXIT.GENERAL,
    );
  }
  const typed = await input({ message });
  if (typed !== requiredWord) {
    throw new CliError(`Aborted. You must type ${requiredWord} to confirm.`, EXIT.GENERAL);
  }
}

/** Prompts for a password (masked input). */
export async function promptPassword(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError(
      "Cannot prompt for password in non-interactive mode. Provide credentials via flags or environment variables.",
      EXIT.GENERAL,
    );
  }
  return password({ message, mask: "*" });
}

/** Prompts for text input with optional default. */
export async function promptText(
  message: string,
  defaultValue?: string,
): Promise<string> {
  return input({ message, ...(defaultValue !== undefined ? { default: defaultValue } : {}) });
}

/** Prompts for a selection from a list of choices. */
export async function promptSelect(
  message: string,
  choices: string[],
): Promise<string> {
  return select({
    message,
    choices: choices.map((c) => ({ value: c })),
  });
}
