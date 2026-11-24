#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "${SCRIPT_DIR}/common.sh"

if [[ "$#" -gt 1 ]] || { [[ "$#" -eq 1 ]] && ! is_valid_environment_name "$1"; }; then
  echo "Usage: npm run env:init [-- <environment>]" >&2
  echo "Environment names may contain letters, numbers, hyphens, and underscores." >&2
  exit 1
fi

if [[ "$#" -eq 1 ]]; then
  environment_file_name="$1.env"
else
  environment_file_name=".env"
fi

environment_file="${REPOSITORY_ROOT}/${environment_file_name}"
environment_template_file="${REPOSITORY_ROOT}/.env.example"

if [[ -e "${environment_file}" || -L "${environment_file}" ]]; then
  echo "Refusing to overwrite existing environment file: ${environment_file_name}" >&2
  exit 1
fi

cp "${environment_template_file}" "${environment_file}"
echo "Created environment file: ${environment_file_name}"
