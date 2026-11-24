#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"

if [[ "$#" -ne 1 ]] || ! is_valid_environment_name "$1"; then
  echo "Usage: npm run env:use -- <environment>" >&2
  echo "Environment names may contain letters, numbers, hyphens, and underscores." >&2
  exit 1
fi

environment_name="$1"
environment_file_name="${environment_name}.env"
environment_file="${REPOSITORY_ROOT}/${environment_file_name}"

if [[ ! -f "${environment_file}" || -L "${environment_file}" ]]; then
  echo "Environment file not found or not a regular file: ${environment_file_name}" >&2
  echo "Create it with: npm run env:init -- ${environment_name}" >&2
  exit 1
fi

if [[ -e "${ACTIVE_ENV_FILE}" || -L "${ACTIVE_ENV_FILE}" ]]; then
  if [[ ! -L "${ACTIVE_ENV_FILE}" ]]; then
    echo "Refusing to replace the existing .env file because it is not a symbolic link." >&2
    echo "Move it first, for example: mv .env existing.env" >&2
    exit 1
  fi

  if [[ "$(readlink "${ACTIVE_ENV_FILE}")" == "${environment_file_name}" ]]; then
    echo "Environment '${environment_name}' is already active (${environment_file_name})."
    exit
  fi
fi

temporary_link="${REPOSITORY_ROOT}/.env.tmp-$$"
trap 'rm -f "${temporary_link}"' EXIT
ln -s "${environment_file_name}" "${temporary_link}"
mv -f "${temporary_link}" "${ACTIVE_ENV_FILE}"

echo "Activated environment '${environment_name}' (${environment_file_name})."
