#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared helpers for the scripts/m2m/ tooling. Sourced by every script;
# never executed directly. Sets `set -euo pipefail` so callers get strict
# mode automatically. Defines the colour palette and log helpers
# (`log_info`, `log_ok`, `log_warn`, `log_err`, `debug`) that all scripts
# use, plus a `confirm` prompt for destructive actions.

set -euo pipefail

# Colour codes — disabled when stderr is not a TTY (CI logs, file
# redirects) so escape sequences don't pollute non-interactive output.
if [[ -t 2 ]]; then
  M2M_RED='\033[0;31m'
  M2M_GREEN='\033[0;32m'
  M2M_BLUE='\033[0;34m'
  M2M_YELLOW='\033[1;33m'
  M2M_BOLD='\033[1m'
  M2M_NC='\033[0m'
else
  M2M_RED='' M2M_GREEN='' M2M_BLUE='' M2M_YELLOW='' M2M_BOLD='' M2M_NC=''
fi

log_info() { printf "${M2M_BLUE}%s${M2M_NC}\n" "$*" >&2; }
log_ok()   { printf "${M2M_GREEN}%s${M2M_NC}\n" "$*" >&2; }
log_warn() { printf "${M2M_YELLOW}%s${M2M_NC}\n" "$*" >&2; }
log_err()  { printf "${M2M_RED}%s${M2M_NC}\n" "$*" >&2; }
log_header() { printf "\n${M2M_YELLOW}${M2M_BOLD}%s${M2M_NC}\n" "$*" >&2; }
debug() { [[ "${VERBOSE:-false}" == "true" ]] && printf "${M2M_YELLOW}[debug]${M2M_NC} %s\n" "$*" >&2 || true; }

# --- M2M role discovery (shared by list-clients.sh and revoke-m2m-role.sh) ---
# Single source of truth for the M2M path + tags. Mirrors the TypeScript
# constants in source/common/utils/m2m-role-arn.ts (M2M_ROLE_NAME_INFIX,
# M2M_STACK_TYPE_TAG_KEY/VALUE, M2M_ISB_ID_TAG_KEY) — keep them in sync.
M2M_ROLE_NAME_INFIX="isb-m2m"
M2M_STACK_TYPE_TAG_KEY="aws-solutions:isb-stack-type"
M2M_STACK_TYPE_TAG_VALUE="M2mClient"
M2M_ISB_ID_TAG_KEY="aws-solutions:isb-id"
M2M_STACK_NAME_TAG_KEY="aws-solutions:isb-stack-name"

# Discover the owning CloudFormation stack names of M2M client roles via direct
# IAM (strongly consistent, unlike resourcegroupstaggingapi). Strategy:
#   1. ListRoles under the M2M path (--path-prefix), so IAM filters server-side
#      instead of returning every role in the account. Paginated via Marker so
#      accounts with >100 roles don't silently truncate.
#   2. Name-prefix check (<ns>-isb-m2m- / -isb-m2m-) as a free belt-and-suspenders
#      before fetching tags.
#   3. Keep roles tagged isb-stack-type=M2mClient (and isb-id=<ns>_isb when a
#      namespace is given), then read the owning stack from isb-stack-name.
#
# Usage: m2m_discover_stack_names <namespace-or-empty> [aws-cli-arg...]
# Prints the sorted, de-duplicated stack names on stdout (one per line).
# Relies on log helpers + `debug` from this file; `VERBOSE` toggles debug.
#
# Returns non-zero if a ListRoles page fails. This matters because callers
# capture stdout via `$(...)`, where `set -e` is disabled — without an explicit
# `return 1` a mid-pagination API failure (expired creds, throttling) would be
# swallowed and the function would emit a partial list with exit 0. That is
# dangerous for the revoke kill switch (silently un-revoked clients), so callers
# MUST check the exit status.
m2m_discover_stack_names() {
  local namespace="$1"; shift
  local aws_args=("$@")

  local path_prefix name_prefix
  if [[ -n "$namespace" ]]; then
    path_prefix="/${M2M_ROLE_NAME_INFIX}/${namespace}/"
    name_prefix="${namespace}-${M2M_ROLE_NAME_INFIX}-"
  else
    path_prefix="/${M2M_ROLE_NAME_INFIX}/"
    # Account-wide (kill-switch) mode: `contains` is an intentionally broad
    # substring pre-filter — the tag check below is the authority. It only
    # gates whether we bother fetching a role's tags.
    name_prefix="-${M2M_ROLE_NAME_INFIX}-"
  fi
  debug "Listing IAM roles under path prefix '${path_prefix}' (paginated)..."

  local candidate_raw="" next_marker="" page_json page_names marker_args
  while :; do
    marker_args=()
    [[ -n "$next_marker" ]] && marker_args+=(--starting-token "$next_marker")
    # Explicit failure propagation: `set -e` does not fire inside the caller's
    # `$(...)`, so surface a failed page ourselves rather than emit a partial list.
    if ! page_json=$(aws iam list-roles \
      --path-prefix "$path_prefix" \
      --output json \
      ${aws_args[@]+"${aws_args[@]}"} \
      ${marker_args[@]+"${marker_args[@]}"} 2>&1); then
      log_err "ListRoles failed during M2M discovery: ${page_json}"
      return 1
    fi
    page_names=$(echo "$page_json" | jq -r --arg p "$name_prefix" \
      '.Roles[] | select(.RoleName | contains($p)) | .RoleName')
    [[ -n "$page_names" ]] && candidate_raw+="${page_names}"$'\n'
    next_marker=$(echo "$page_json" | jq -r '.NextToken // empty')
    [[ -z "$next_marker" ]] && break
  done

  local role tags_json stack_type isb_id stack_name stack_names=""
  while IFS= read -r role; do
    [[ -z "$role" ]] && continue
    # Fail closed, same as the ListRoles page above: a silent empty-tags
    # fallback would drop this role from discovery, leaving a client
    # un-revoked by the kill switch with no indication.
    if ! tags_json=$(aws iam list-role-tags \
      --role-name "$role" \
      --output json \
      ${aws_args[@]+"${aws_args[@]}"} 2>&1); then
      log_err "ListRoleTags failed for ${role} during M2M discovery: ${tags_json}"
      return 1
    fi

    stack_type=$(echo "$tags_json" | jq -r --arg k "$M2M_STACK_TYPE_TAG_KEY" '.Tags[]? | select(.Key==$k) | .Value')
    isb_id=$(echo "$tags_json" | jq -r --arg k "$M2M_ISB_ID_TAG_KEY" '.Tags[]? | select(.Key==$k) | .Value')
    stack_name=$(echo "$tags_json" | jq -r --arg k "$M2M_STACK_NAME_TAG_KEY" '.Tags[]? | select(.Key==$k) | .Value')

    debug "  ${role}: stack-type='${stack_type}' isb-id='${isb_id}' stack-name='${stack_name}'"

    [[ "$stack_type" != "$M2M_STACK_TYPE_TAG_VALUE" ]] && continue
    [[ -n "$namespace" && "$isb_id" != "${namespace}_isb" ]] && continue
    if [[ -z "$stack_name" ]]; then
      log_warn "role ${role} matches but has no ${M2M_STACK_NAME_TAG_KEY} tag — skipping"
      continue
    fi
    stack_names+="${stack_name}"$'\n'
  done < <(echo "$candidate_raw" | sed '/^$/d')

  echo "$stack_names" | sort -u | sed '/^$/d'
}

# Prompt for y/N confirmation. Returns 0 on yes, 1 on no.
# Skips the prompt and returns 0 if SKIP_CONFIRMATION is "true".
# In non-interactive contexts (no /dev/tty — CI, cron, &c.) emits a clear
# message and returns 1 rather than letting `read </dev/tty` produce a raw
# bash error.
confirm() {
  local prompt="${1:-Continue?}"
  if [[ "${SKIP_CONFIRMATION:-false}" == "true" ]]; then
    debug "SKIP_CONFIRMATION=true, auto-accepting: ${prompt}"
    return 0
  fi
  if [[ ! -e /dev/tty ]]; then
    log_err "Interactive confirmation required but no /dev/tty is available."
    log_err "Pass --skip-confirmation for non-interactive execution."
    return 1
  fi
  local reply
  read -r -p "${prompt} [y/N] " reply </dev/tty || return 1
  [[ "$reply" =~ ^[Yy]$ ]]
}
