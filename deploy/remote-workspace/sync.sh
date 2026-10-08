#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
MUTAGEN_BIN="${MUTAGEN_BIN:-mutagen}"

usage() {
  cat <<'USAGE'
Usage:
  sync.sh create <account> <local-project-directory> <project-name> [session-name]
  sync.sh list
  sync.sh flush <session-name>
  sync.sh pause <session-name>
  sync.sh resume <session-name>
  sync.sh terminate <session-name>

Create uses Mutagen two-way-safe mode. The local .git directory stays local;
dependency, build, cache, environment and secret files are ignored on both sides.
USAGE
}

fail() { printf 'sync.sh: %s\n' "$*" >&2; exit 2; }

valid_name() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]?$ ]]
}

require_mutagen() {
  command -v "$MUTAGEN_BIN" >/dev/null 2>&1 || fail "Mutagen is required; install the official Mutagen CLI first"
}

remote_quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

fnv1a64() {
  local value="$1" hash=0xcbf29ce484222325 byte
  local -a bytes
  while read -ra bytes; do
    for byte in "${bytes[@]}"; do
      hash=$(((hash ^ 16#$byte) * 0x100000001b3))
    done
  done < <(printf '%s' "$value" | od -An -v -tx1)
  printf '%016x' "$hash"
}

safe_session_name() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || fail "session name may contain only letters, numbers, dot, underscore and dash"
}

command_name="${1:-}"
case "$command_name" in
  create)
    [[ $# -ge 4 && $# -le 5 ]] || { usage >&2; exit 2; }
    account="$2"
    valid_name "$account" || fail "invalid account name"
    config="$ROOT_DIR/config/$account.json"
    [[ -r "$config" ]] || fail "missing generated account config: $config"
    command -v jq >/dev/null 2>&1 || fail "jq is required to read generated account config"
    command -v ssh >/dev/null 2>&1 || fail "OpenSSH client is required for the preflight check"
    require_mutagen
    local_source="$(realpath -e -- "$3")" || fail "local project path does not exist"
    [[ -d "$local_source" ]] || fail "local project path is not a directory"
    project="$4"
    [[ -n "$project" && "$project" != "." && "$project" != ".." && "$project" != */* && "$project" != *\\* && ! "$project" =~ [[:cntrl:]] ]] || fail "project name must be one safe path segment without control characters"
    host="$(jq -er '.sshHost | select(type == "string" and length > 0)' "$config")" || fail "account config has no SSH host"
    port="$(jq -er '.sshPort | select(type == "number" and . >= 1024 and . <= 65535)' "$config")" || fail "account config has no valid SSH port"
    user="$(jq -er '.sshUser | select(type == "string" and length > 0)' "$config")" || fail "account config has no SSH user"
    root="$(jq -er '.workspaceRoot | select(. == "/workspace")' "$config")" || fail "account workspace root must be /workspace"
    host_slug="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g' | cut -c1-24)"
    [[ -n "$host_slug" ]] || host_slug="host"
    alias="kanna-${host_slug}-$(fnv1a64 "$host")-${port}"
    project_slug="$(printf '%s' "$project" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^[^a-z0-9]+//; s/[^a-z0-9]+$//' | cut -c1-20)"
    [[ -n "$project_slug" ]] || project_slug="project"
    if [[ $# -eq 5 ]]; then
      session="$5"
    else
      session="${alias}-${project_slug}-$(fnv1a64 "$project")"
    fi
    safe_session_name "$session"
    endpoint="${user}@${alias}:${root}/${project}"
    remote_project="${root}/${project}"
    quoted_project="$(remote_quote "$remote_project")"
    remote_command="mkdir -p -- ${quoted_project} && if ! git -C ${quoted_project} rev-parse --is-inside-work-tree >/dev/null 2>&1; then git -C ${quoted_project} init -q; fi"
    ssh_config="$(ssh -G "$alias")" || fail "Unable to inspect SSH alias $alias"
    printf '%s\n' "$ssh_config" | awk \
      -v expected_host="$host" \
      -v expected_port="$port" \
      -v expected_user="$user" \
      'BEGIN { strict = 0; host = 0; port = 0; user = 0; identities = 0 }
       $1 == "stricthostkeychecking" && ($2 == "yes" || $2 == "true") { strict = 1 }
       $1 == "hostname" && tolower($2) == tolower(expected_host) { host = 1 }
       $1 == "port" && $2 == expected_port { port = 1 }
       $1 == "user" && $2 == expected_user { user = 1 }
       $1 == "identitiesonly" && ($2 == "yes" || $2 == "true") { identities = 1 }
       END { exit !(strict && host && port && user && identities) }' \
      || fail "SSH alias $alias must map to $user@$host:$port, set StrictHostKeyChecking and IdentitiesOnly yes, and use a dedicated UserKnownHostsFile"
    known_hosts_file="$(printf '%s\n' "$ssh_config" | awk '$1 == "userknownhostsfile" { for (i = 2; i <= NF; i++) if ($i != "none" && $i != "/dev/null" && $i !~ /(^|\/)\.ssh\/known_hosts(2)?$/) { print $i; exit } }')"
    [[ -n "$known_hosts_file" && -f "$known_hosts_file" && -r "$known_hosts_file" ]] || fail "SSH alias $alias must use a readable dedicated UserKnownHostsFile"
    ssh -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes "$user@$alias" "$remote_command" || fail "SSH preflight failed; check your loaded client key, host key and account port"
    exec "$MUTAGEN_BIN" sync create \
      --name "$session" \
      --sync-mode two-way-safe \
      --ignore-vcs \
      --ignore .git \
      --ignore .kanna \
      --ignore .codex \
      --ignore .remote-workspace \
      --ignore .ssh \
      --ignore node_modules \
      --ignore vendor \
      --ignore .venv \
      --ignore venv \
      --ignore target \
      --ignore dist \
      --ignore build \
      --ignore .next \
      --ignore .turbo \
      --ignore .cache \
      --ignore .pytest_cache \
      --ignore __pycache__ \
      --ignore .env \
      --ignore '.env.*' \
      --ignore secrets \
      --ignore '*.pem' \
      --ignore '*.key' \
      "$local_source" "$endpoint"
    ;;
  list)
    [[ $# -eq 1 ]] || { usage >&2; exit 2; }
    require_mutagen
    exec "$MUTAGEN_BIN" sync list
    ;;
  flush|pause|resume|terminate)
    [[ $# -eq 2 ]] || { usage >&2; exit 2; }
    safe_session_name "$2"
    require_mutagen
    exec "$MUTAGEN_BIN" sync "$command_name" "$2"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
