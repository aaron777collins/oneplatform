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

  local commands="auth profile user role ontology data connector mapping webhook-out pipeline schedule dlq exec app plugin logs config status service sdk version completion"

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
    user)
      COMPREPLY=( \$(compgen -W "list invite get update deactivate import" -- "\${cur}") )
      ;;
    role)
      COMPREPLY=( \$(compgen -W "list create assign remove" -- "\${cur}") )
      ;;
    ontology)
      COMPREPLY=( \$(compgen -W "list get create update delete validate diff migrate migration-status migration-rollback export import" -- "\${cur}") )
      ;;
    data)
      COMPREPLY=( \$(compgen -W "query get create update delete import export" -- "\${cur}") )
      ;;
    connector)
      COMPREPLY=( \$(compgen -W "list create get update delete test trigger" -- "\${cur}") )
      ;;
    mapping)
      COMPREPLY=( \$(compgen -W "list create update delete preview" -- "\${cur}") )
      ;;
    webhook-out)
      COMPREPLY=( \$(compgen -W "list create update delete test logs" -- "\${cur}") )
      ;;
    pipeline)
      COMPREPLY=( \$(compgen -W "list get create update delete trigger runs run-status run-cancel run-logs" -- "\${cur}") )
      ;;
    schedule)
      COMPREPLY=( \$(compgen -W "list create pause resume delete" -- "\${cur}") )
      ;;
    dlq)
      COMPREPLY=( \$(compgen -W "list replay discard" -- "\${cur}") )
      ;;
    exec)
      COMPREPLY=( \$(compgen -W "run history logs" -- "\${cur}") )
      ;;
    app)
      COMPREPLY=( \$(compgen -W "init list get create deploy dev logs delete env-set env-list rollback" -- "\${cur}") )
      ;;
    plugin)
      COMPREPLY=( \$(compgen -W "list install upgrade rollback enable disable uninstall info create pack validate simulate-hook dev publish" -- "\${cur}") )
      ;;
    logs)
      COMPREPLY=( \$(compgen -W "query tail audit export" -- "\${cur}") )
      ;;
    config)
      COMPREPLY=( \$(compgen -W "export import diff validate" -- "\${cur}") )
      ;;
    service)
      COMPREPLY=( \$(compgen -W "rotate-keys health restart scale" -- "\${cur}") )
      ;;
    sdk)
      COMPREPLY=( \$(compgen -W "generate generate-types" -- "\${cur}") )
      ;;
    completion)
      COMPREPLY=( \$(compgen -W "bash zsh fish" -- "\${cur}") )
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
    'mapping:Field mapping rules'
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
    auth)
      local -a sub=('login' 'logout' 'status' 'whoami' 'generate-key' 'list-keys' 'revoke-key' 'rotate-key' 'emergency-rotate')
      _describe 'auth subcommand' sub
      ;;
    profile)
      local -a sub=('add' 'list' 'use' 'remove')
      _describe 'profile subcommand' sub
      ;;
    user)
      local -a sub=('list' 'invite' 'get' 'update' 'deactivate' 'import')
      _describe 'user subcommand' sub
      ;;
    role)
      local -a sub=('list' 'create' 'assign' 'remove')
      _describe 'role subcommand' sub
      ;;
    ontology)
      local -a sub=('list' 'get' 'create' 'update' 'delete' 'validate' 'diff' 'migrate' 'migration-status' 'migration-rollback' 'export' 'import')
      _describe 'ontology subcommand' sub
      ;;
    data)
      local -a sub=('query' 'get' 'create' 'update' 'delete' 'import' 'export')
      _describe 'data subcommand' sub
      ;;
    connector)
      local -a sub=('list' 'create' 'get' 'update' 'delete' 'test' 'trigger')
      _describe 'connector subcommand' sub
      ;;
    mapping)
      local -a sub=('list' 'create' 'update' 'delete' 'preview')
      _describe 'mapping subcommand' sub
      ;;
    webhook-out)
      local -a sub=('list' 'create' 'update' 'delete' 'test' 'logs')
      _describe 'webhook-out subcommand' sub
      ;;
    pipeline)
      local -a sub=('list' 'get' 'create' 'update' 'delete' 'trigger' 'runs' 'run-status' 'run-cancel' 'run-logs')
      _describe 'pipeline subcommand' sub
      ;;
    schedule)
      local -a sub=('list' 'create' 'pause' 'resume' 'delete')
      _describe 'schedule subcommand' sub
      ;;
    dlq)
      local -a sub=('list' 'replay' 'discard')
      _describe 'dlq subcommand' sub
      ;;
    exec)
      local -a sub=('run' 'history' 'logs')
      _describe 'exec subcommand' sub
      ;;
    app)
      local -a sub=('init' 'list' 'get' 'create' 'deploy' 'dev' 'logs' 'delete' 'env-set' 'env-list' 'rollback')
      _describe 'app subcommand' sub
      ;;
    plugin)
      local -a sub=('list' 'install' 'upgrade' 'rollback' 'enable' 'disable' 'uninstall' 'info' 'create' 'pack' 'validate' 'simulate-hook' 'dev' 'publish')
      _describe 'plugin subcommand' sub
      ;;
    logs)
      local -a sub=('query' 'tail' 'audit' 'export')
      _describe 'logs subcommand' sub
      ;;
    config)
      local -a sub=('export' 'import' 'diff' 'validate')
      _describe 'config subcommand' sub
      ;;
    service)
      local -a sub=('rotate-keys' 'health' 'restart' 'scale')
      _describe 'service subcommand' sub
      ;;
    sdk)
      local -a sub=('generate' 'generate-types')
      _describe 'sdk subcommand' sub
      ;;
    completion)
      local -a sub=('bash' 'zsh' 'fish')
      _describe 'completion subcommand' sub
      ;;
  esac
}

_op "\$@"
`.trimStart();

// Fish completion script
const FISH_COMPLETION = `
# OnePlatform CLI fish completion
# Save to ~/.config/fish/completions/op.fish

set -l commands auth profile user role ontology data connector mapping webhook-out pipeline schedule dlq exec app plugin logs config status service sdk version completion

complete -c op -f -n __fish_use_subcommand -a "\$commands"

# auth subcommands
complete -c op -f -n '__fish_seen_subcommand_from auth' -a 'login logout status whoami generate-key list-keys revoke-key rotate-key emergency-rotate'

# profile subcommands
complete -c op -f -n '__fish_seen_subcommand_from profile' -a 'add list use remove'

# user subcommands
complete -c op -f -n '__fish_seen_subcommand_from user' -a 'list invite get update deactivate import'

# role subcommands
complete -c op -f -n '__fish_seen_subcommand_from role' -a 'list create assign remove'

# ontology subcommands
complete -c op -f -n '__fish_seen_subcommand_from ontology' -a 'list get create update delete validate diff migrate migration-status migration-rollback export import'

# data subcommands
complete -c op -f -n '__fish_seen_subcommand_from data' -a 'query get create update delete import export'

# connector subcommands
complete -c op -f -n '__fish_seen_subcommand_from connector' -a 'list create get update delete test trigger'

# mapping subcommands
complete -c op -f -n '__fish_seen_subcommand_from mapping' -a 'list create update delete preview'

# webhook-out subcommands
complete -c op -f -n '__fish_seen_subcommand_from webhook-out' -a 'list create update delete test logs'

# pipeline subcommands
complete -c op -f -n '__fish_seen_subcommand_from pipeline' -a 'list get create update delete trigger runs run-status run-cancel run-logs'

# schedule subcommands
complete -c op -f -n '__fish_seen_subcommand_from schedule' -a 'list create pause resume delete'

# dlq subcommands
complete -c op -f -n '__fish_seen_subcommand_from dlq' -a 'list replay discard'

# exec subcommands
complete -c op -f -n '__fish_seen_subcommand_from exec' -a 'run history logs'

# app subcommands
complete -c op -f -n '__fish_seen_subcommand_from app' -a 'init list get create deploy dev logs delete env-set env-list rollback'

# plugin subcommands
complete -c op -f -n '__fish_seen_subcommand_from plugin' -a 'list install upgrade rollback enable disable uninstall info create pack validate simulate-hook dev publish'

# logs subcommands
complete -c op -f -n '__fish_seen_subcommand_from logs' -a 'query tail audit export'

# config subcommands
complete -c op -f -n '__fish_seen_subcommand_from config' -a 'export import diff validate'

# service subcommands
complete -c op -f -n '__fish_seen_subcommand_from service' -a 'rotate-keys health restart scale'

# sdk subcommands
complete -c op -f -n '__fish_seen_subcommand_from sdk' -a 'generate generate-types'

# completion subcommands
complete -c op -f -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'

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
