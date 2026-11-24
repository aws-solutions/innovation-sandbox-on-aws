#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck source-path=SCRIPTDIR
#
# M2M client role revocation tool — emergency access control for per-client
# M2M IAM roles. Provides immediate revocation of M2M access without
# requiring a stack deployment.
#
# Per-client M2M model: each automation client has its own dedicated
# CloudFormation stack creating one IAM role. This script attaches/removes
# inline policies on those roles to deny or restore access.
#
# For PERMANENT removal, just `cdk destroy <client-stack>`. This script is
# for TEMPORARY block (suspected leak, awaiting investigation, etc.) where
# you want to keep the stack and parameters intact.
#
# Bulk-mode discovery (--action deny-all / restore-all) lists roles under the
# M2M path (/isb-m2m/[<ns>/]) via ListRoles --path-prefix, then keeps only
# those tagged aws-solutions:isb-stack-type=M2mClient (and
# aws-solutions:isb-id=<ns>_isb when --namespace is given; omit it for the
# account-wide kill switch across all namespaces). The owning stack name is
# read from the aws-solutions:isb-stack-name tag — IAM roles don't get the CFN
# auto-tag aws:cloudformation:stack-name. Direct IAM is strongly consistent;
# resourcegroupstaggingapi is eventually consistent for IAM and would lag
# minutes-to-hours after a tag change.
#
# Single-client actions (deny / revoke-sessions / restore) take --client-stack
# and resolve the role from the stack's M2MRoleArn output — no namespace needed.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
. "${SCRIPT_DIR}/_common.sh"

CLIENT_STACK=""
NAMESPACE=""
REGION="${AWS_REGION:-us-east-1}"
ACTION=""
PROFILE=""
SKIP_CONFIRMATION="false"
VERBOSE="false"

REVOKE_POLICY_NAME="isb-m2m-revoked"

print_usage() {
  cat >&2 <<EOF
Usage: revoke-m2m-role.sh --action <deny|revoke-sessions|restore> --client-stack <stack> [options]
       revoke-m2m-role.sh --action <deny-all|restore-all> [--namespace <ns>] [options]

Revoke or restore M2M client role access. No stack deployment required.

Actions:
  deny              Attach Deny policy — blocks ALL access immediately to one client (existing + new sessions)
  deny-all          Apply deny to every M2M client stack found by tag (all namespaces, or one via --namespace)
  revoke-sessions   Attach Deny policy for sessions issued before now — invalidates existing sessions only
  restore           Remove revocation policy — undo deny or revoke-sessions for one client
  restore-all       Apply restore to every M2M client stack found by tag (all namespaces, or one via --namespace)

Options:
  --action, -a         Revocation action [required]
  --client-stack, -c   Client stack name (e.g. InnovationSandbox-M2mClient-Admin-deploy-pipeline) [required for single-client actions]
  --namespace, -n      Scope bulk discovery to one ISB deployment (matches aws-solutions:isb-id=<ns>_isb). Omit to affect ALL namespaces (account-wide kill switch).
  --region             AWS region (default: \$AWS_REGION or us-east-1)
  --profile            AWS profile to use (CLI default chain otherwise)
  --skip-confirmation  Skip the interactive y/N prompt on bulk actions (deny-all / restore-all)
  --verbose, -v        Print AWS calls and per-role tag inspection to stderr
  --help, -h           Show this help

Bulk discovery lists roles under the M2M path (/isb-m2m/[<ns>/]) and filters
by tag (the role is reliably tagged regardless of deploy path; stack-level
tags may not be):
  aws-solutions:isb-stack-type=M2mClient   (always)
  aws-solutions:isb-id=<ns>_isb            (added when --namespace is provided)

Examples:
  # Single client (find the stack name via list-clients.sh or the CFN console)
  ./scripts/m2m/revoke-m2m-role.sh --action deny --client-stack InnovationSandbox-M2mClient-Admin-deploy-pipeline

  # All M2M clients in the account (emergency kill switch)
  ./scripts/m2m/revoke-m2m-role.sh --action deny-all

  # All M2M clients in one namespace
  ./scripts/m2m/revoke-m2m-role.sh --action restore-all --namespace myisb
EOF
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --action|-a) ACTION="$2"; shift 2 ;;
    --client-stack|-c) CLIENT_STACK="$2"; shift 2 ;;
    --namespace|-n) NAMESPACE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --skip-confirmation) SKIP_CONFIRMATION="true"; shift ;;
    --verbose|-v) VERBOSE="true"; shift ;;
    --help|-h) print_usage; exit 0 ;;
    *) log_err "Unknown option: $1"; print_usage; exit 2 ;;
  esac
done

AWS_SRC_ARGS=(--region "$REGION")
[[ -n "$PROFILE" ]] && AWS_SRC_ARGS+=(--profile "$PROFILE")

debug "Region: ${REGION}"
debug "Profile: ${PROFILE:-<default chain>}"
debug "Action: ${ACTION}"
[[ -n "$NAMESPACE" ]] && debug "Namespace filter: ${NAMESPACE}_isb"
if [[ "$VERBOSE" == "true" ]]; then
  CALLER=$(aws sts get-caller-identity --output json "${AWS_SRC_ARGS[@]}" 2>&1 || true)
  debug "Caller identity: ${CALLER}"
fi

if [[ -z "$ACTION" ]]; then
  log_err "--action is required"
  print_usage
  exit 2
fi

if [[ "$ACTION" != "deny" && "$ACTION" != "deny-all" && "$ACTION" != "revoke-sessions" && "$ACTION" != "restore" && "$ACTION" != "restore-all" ]]; then
  log_err "--action must be one of: deny, deny-all, revoke-sessions, restore, restore-all"
  exit 2
fi

# Bulk actions: discover all client stacks via direct IAM (strongly
# consistent; see header comment and m2m_discover_stack_names in _common.sh).
if [[ "$ACTION" == "deny-all" || "$ACTION" == "restore-all" ]]; then
  # --namespace is optional here: omitting it is the account-wide "kill the
  # entire M2M surface" mode; providing it scopes to one deployment.
  if [[ -n "$NAMESPACE" ]] && ! [[ "$NAMESPACE" =~ ^[a-zA-Z0-9]{3,8}$ ]]; then
    log_err "--namespace must be 3-8 alphanumeric characters (got '$NAMESPACE')."
    exit 2
  fi
  scope_descr=$([[ -n "$NAMESPACE" ]] && echo "namespace '${NAMESPACE}'" || echo "EVERY namespace")

  log_warn "Bulk action '${ACTION}' will affect every M2M client stack in ${scope_descr} in this account/region."
  if ! confirm "Proceed?"; then
    log_info "Aborted."
    exit 1
  fi
  log_info "Discovering M2M client stacks via IAM role tags..."

  # Split declaration from assignment so the function's exit status is checked
  # (a combined `local X=$(...)`/`X=$(...)` would mask it). Aborting on a failed
  # discovery is critical here: silently proceeding with a partial list would
  # leave some clients un-revoked during an incident.
  if ! STACK_NAMES=$(m2m_discover_stack_names "$NAMESPACE" "${AWS_SRC_ARGS[@]}"); then
    log_err "Discovery failed — aborting '${ACTION}' to avoid a partial revoke."
    exit 1
  fi

  if [[ -z "$STACK_NAMES" ]]; then
    log_info "No M2M client stacks found in ${scope_descr}."
    exit 0
  fi

  PER_CLIENT_ACTION=$([[ "$ACTION" == "deny-all" ]] && echo "deny" || echo "restore")
  BULK_TOTAL=0
  BULK_FAILURES=0
  for stack in $STACK_NAMES; do
    BULK_TOTAL=$((BULK_TOTAL + 1))
    log_header "=== ${stack} ==="
    SUB_ARGS=(--action "$PER_CLIENT_ACTION" --client-stack "$stack" --region "$REGION")
    [[ -n "$PROFILE" ]] && SUB_ARGS+=(--profile "$PROFILE")
    [[ "$VERBOSE" == "true" ]] && SUB_ARGS+=(--verbose)
    if ! "$0" "${SUB_ARGS[@]}"; then
      log_warn "action failed for ${stack} (continuing)"
      BULK_FAILURES=$((BULK_FAILURES + 1))
    fi
  done
  if (( BULK_FAILURES > 0 )); then
    log_err "${BULK_FAILURES} of ${BULK_TOTAL} bulk operations failed."
    exit 1
  fi
  exit 0
fi

# Single-client actions: client stack is required
if [[ -z "$CLIENT_STACK" ]]; then
  log_err "--client-stack is required for ${ACTION}"
  print_usage
  exit 2
fi

debug "describe-stacks --stack-name ${CLIENT_STACK} (looking for M2MRoleArn output)"
ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$CLIENT_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='M2MRoleArn'].OutputValue" \
  --output text \
  "${AWS_SRC_ARGS[@]}" 2>/dev/null || true)

if [[ -z "$ROLE_ARN" || "$ROLE_ARN" == "None" ]]; then
  log_err "Could not resolve M2MRoleArn from client stack '${CLIENT_STACK}'."
  log_err "Verify the stack exists and is fully deployed."
  exit 1
fi

ROLE_NAME="${ROLE_ARN##*/}"

log_info "Target client stack: ${CLIENT_STACK}"
log_info "Target role: ${ROLE_NAME}"
log_info "Action: ${ACTION}"

case "$ACTION" in
  deny)
    POLICY_DOC='{"Version":"2012-10-17","Statement":[{"Sid":"IsbM2mRevoked","Effect":"Deny","Action":"execute-api:Invoke","Resource":"*"}]}'

    aws iam put-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-name "$REVOKE_POLICY_NAME" \
      --policy-document "$POLICY_DOC" \
      "${AWS_SRC_ARGS[@]}"

    log_ok "Attached Deny policy '${REVOKE_POLICY_NAME}' to ${ROLE_NAME}"
    log_info "All existing and new sessions for this client are blocked immediately."
    log_info "To undo: --action restore --client-stack ${CLIENT_STACK}"
    ;;

  revoke-sessions)
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    POLICY_DOC="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"IsbM2mRevokeSessionsBefore\",\"Effect\":\"Deny\",\"Action\":\"execute-api:Invoke\",\"Resource\":\"*\",\"Condition\":{\"DateLessThan\":{\"aws:TokenIssueTime\":\"${TIMESTAMP}\"}}}]}"

    aws iam put-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-name "$REVOKE_POLICY_NAME" \
      --policy-document "$POLICY_DOC" \
      "${AWS_SRC_ARGS[@]}"

    log_ok "Attached session revocation policy to ${ROLE_NAME}"
    log_info "Sessions issued before ${TIMESTAMP} are blocked."
    log_info "New AssumeRole calls will produce valid sessions."
    log_info "To undo: --action restore --client-stack ${CLIENT_STACK}"
    ;;

  restore)
    if aws iam get-role-policy --role-name "$ROLE_NAME" --policy-name "$REVOKE_POLICY_NAME" "${AWS_SRC_ARGS[@]}" >/dev/null 2>&1; then
      aws iam delete-role-policy \
        --role-name "$ROLE_NAME" \
        --policy-name "$REVOKE_POLICY_NAME" \
        "${AWS_SRC_ARGS[@]}"
      log_ok "Removed inline policy '${REVOKE_POLICY_NAME}' from ${ROLE_NAME}"
      log_info "Client access fully restored."
    else
      log_info "Nothing to restore — role ${ROLE_NAME} has no revocation policy attached."
    fi
    ;;
esac
