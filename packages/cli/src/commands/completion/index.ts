/**
 * completion command group — shell completion scripts for bash, zsh, and fish.
 * Scripts are static strings; they reference the 'op' binary name directly.
 * Users source these scripts in their shell config.
 */
import type { Command } from "commander";

// Bash completion script — uses compgen and _op helper function
const BASH_COMPLETION = `
# OnePlatform CLI bash completion
# Add to ~/.bashrc: source <(op completion bash)
_op_completion() {
  local cur prev words cword
  _init_completion || return

  local commands="auth profile user role ontology data connector webhook-out pipeline schedule dlq exec app plugin logs config status service sdk version completion"

  if [ \${cword} -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "\${commands}" -- "\${cur}") )
    return
  fi

  case "\${words[1]}" in
    auth)
      COMPREPLY=( \$(compgen -W "login logout status whoami generate-key list-keys revoke-key rotate-key emergency-rotate" -- "\${cur}") )
      ;;
    profile)
      COMPREPLY=( \$(compgen -W "add list use remove" -- "\${cur}") )
      ;;
    pipeline)
      COMPREPLY=( \$(compgen -W "list get create update delete trigger runs run-status run-cancel run-logs" -- "\${cur}") )
      ;;
    app)
      COMPREPLY=( \$(compgen -W "list get create deploy dev logs delete env-set env-list rollback" -- "\${cur}") )
      ;;
    plugin)
      COMPREPLY=( \$(compgen -W "list install enable disable uninstall info create pack validate simulate-hook" -- "\${cur}") )
      ;;
    *)
      COMPREPLY=()
      ;;
  esac
}

complete -F _op_completion op
`.trimStart();

// Zsh completion script
const ZSH_COMPLETION = `
# OnePlatform CLI zsh completion
# Add to ~/.zshrc: source <(op completion zsh)
#compdef op

_op() {
  local -a commands
  commands=(
    'auth:Authentication and credential management'
    'profile:Multi-environment profile management'
    'user:User management'
    'role:Role management'
    'ontology:Schema management'
    'data:Data CRUD operations'
    'connector:Data connector management'
    'webhook-out:Outbound webhook management'
    'pipeline:Pipeline management'
    'schedule:Cron schedule management'
    'dlq:Dead-letter queue management'
    'exec:Direct code execution'
    'app:App management'
    'plugin:Plugin management'
    'logs:Log management'
    'config:Platform configuration export/import'
    'status:Platform health status'
    'service:Service administration'
    'sdk:SDK code generation'
    'version:Print version information'
    'completion:Generate shell completion scripts'
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  case \${words[2]} in
    pipeline)
      local -a sub=('list' 'get' 'create' 'update' 'delete' 'trigger' 'runs' 'run-status' 'run-cancel' 'run-logs')
      _describe 'pipeline subcommand' sub
      ;;
    app)
      local -a sub=('list' 'get' 'create' 'deploy' 'dev' 'logs' 'delete' 'env-set' 'env-list' 'rollback')
      _describe 'app subcommand' sub
      ;;
  esac
}

_op "\$@"
`.trimStart();

// Fish completion script
const FISH_COMPLETION = `
# OnePlatform CLI fish completion
# Save to ~/.config/fish/completions/op.fish

set -l commands auth profile user role ontology data connector webhook-out pipeline schedule dlq exec app plugin logs config status service sdk version completion

complete -c op -f -n __fish_use_subcommand -a "\$commands"

# auth subcommands
complete -c op -f -n '__fish_seen_subcommand_from auth' -a 'login logout status whoami generate-key list-keys revoke-key rotate-key emergency-rotate'

# pipeline subcommands
complete -c op -f -n '__fish_seen_subcommand_from pipeline' -a 'list get create update delete trigger runs run-status run-cancel run-logs'

# app subcommands
complete -c op -f -n '__fish_seen_subcommand_from app' -a 'list get create deploy dev logs delete env-set env-list rollback'

# plugin subcommands
complete -c op -f -n '__fish_seen_subcommand_from plugin' -a 'list install enable disable uninstall info create pack validate simulate-hook'

# Global flags
complete -c op -l profile -d 'Credential profile to use'
complete -c op -s o -l output -d 'Output format: table|json|jsonl|tsv'
complete -c op -s y -l yes -d 'Skip confirmations'
complete -c op -s q -l quiet -d 'Suppress all output except errors'
complete -c op -l no-color -d 'Disable ANSI colors'
complete -c op -s v -l verbose -d 'Print stack traces and HTTP details'
`.trimStart();

export function registerCompletion(program: Command): void {
  const completion = program
    .command("completion")
    .description("Generate shell completion scripts");

  completion
    .command("bash")
    .description("Print bash completion script (add to ~/.bashrc: source <(op completion bash))")
    .action(() => {
      process.stdout.write(BASH_COMPLETION);
    });

  completion
    .command("zsh")
    .description("Print zsh completion script (add to ~/.zshrc: source <(op completion zsh))")
    .action(() => {
      process.stdout.write(ZSH_COMPLETION);
    });

  completion
    .command("fish")
    .description("Print fish completion script (save to ~/.config/fish/completions/op.fish)")
    .action(() => {
      process.stdout.write(FISH_COMPLETION);
    });
}
