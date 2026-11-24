#!/usr/bin/env bash
# Shared helpers for scripts/env entrypoints. This file must be sourced.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "This file must be sourced by an environment command." >&2
  exit 1
fi

set -euo pipefail

ENV_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${ENV_SCRIPT_DIR}/../.." && pwd)"
ACTIVE_ENV_FILE="${REPOSITORY_ROOT}/.env"

is_valid_environment_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]
}

show_current_environment() {
  if [[ ! -e "${ACTIVE_ENV_FILE}" && ! -L "${ACTIVE_ENV_FILE}" ]]; then
    echo "No environment is active because .env does not exist." >&2
    return 1
  fi

  if [[ ! -L "${ACTIVE_ENV_FILE}" ]]; then
    echo "Active environment: .env (regular file, not managed by env:use)."
    return
  fi

  local link_target
  link_target="$(readlink "${ACTIVE_ENV_FILE}")"

  local resolved_target
  if [[ "${link_target}" = /* ]]; then
    resolved_target="${link_target}"
  else
    resolved_target="${REPOSITORY_ROOT}/${link_target}"
  fi

  if [[ ! -f "${resolved_target}" ]]; then
    echo "Active environment link is broken: .env -> ${link_target}" >&2
    return 1
  fi

  local environment_file_name
  environment_file_name="${resolved_target##*/}"

  local environment_name
  environment_name="${environment_file_name%.env}"
  echo "Active environment: ${environment_name} (.env -> ${link_target})"
}
