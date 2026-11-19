#!/bin/bash
set -e
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

# =============================================================================
# Destroy-specific functions
# =============================================================================

show_help() {
  cat <<EOF
Innovation Sandbox - Unified Destroy Script

Usage:
  ./scripts/destroy.sh                  Destroy all stacks (with confirmation)
  ./scripts/destroy.sh account-pool     Destroy only AccountPool stack
  ./scripts/destroy.sh idc              Destroy only IDC stack
  ./scripts/destroy.sh data             Destroy only Data stack
  ./scripts/destroy.sh compute          Destroy only Compute stack
  ./scripts/destroy.sh data compute     Destroy multiple specific stacks
  ./scripts/destroy.sh all              Destroy all stacks (explicit)

Options:
  --skip-confirmation    Skip the interactive confirmation prompt
  --help, -h             Show this help message

Note: Stacks are destroyed in reverse deployment order (compute, data, idc, account-pool).
EOF
  exit 0
}

validate_required_vars() {
  if [ -z "$DEPLOY_REGION" ]; then
    log_err "DEPLOY_REGION is not set in .env"
    exit 1
  fi
}

destroy_stack() {
  local stack="$1"
  local stack_name
  local profile
  stack_name=$(get_stack_name "$stack")
  profile=$(get_stack_profile "$stack")
  local args=("$stack_name" --force)

  [ -n "$profile" ] && args+=(--profile "$profile")

  run_cdk destroy "${args[@]}"
}

show_confirmation() {
  if [ ! -t 0 ]; then
    printf "${RED}Error: Interactive confirmation required but stdin is not a terminal.${NC}\n"
    printf "Use --skip-confirmation for non-interactive execution.\n"
    exit 1
  fi

  printf "========================================\n"
  printf "Innovation Sandbox - Destroy\n"
  printf "========================================\n"
  printf "\n"

  printf "Configuration:\n"
  printf "  Deploy Region:  ${BLUE}%s${NC}\n" "${DEPLOY_REGION}"
  printf "  Stack Prefix:   ${BLUE}%s${NC}\n" "${PREFIX}"
  printf "\n"

  printf "Stacks to destroy:\n"
  for stack in "${STACKS_TO_DESTROY[@]}"; do
    local stack_name
    local profile
    stack_name=$(get_stack_name "$stack")
    profile=$(get_stack_profile "$stack")
    local details=""
    [ -n "$profile" ] && details=" [profile: $profile]"
    printf "  - ${BLUE}%s${NC}%s\n" "$stack_name" "$details"
  done
  printf "\n"

  printf "\n"
  log_warn "This will PERMANENTLY destroy these stacks in ${DEPLOY_REGION}. Do you want to continue? (y/N) "
  read -r response

  if [[ ! "$response" =~ ^[Yy]$ ]]; then
    printf "\nDestroy cancelled.\n"
    exit 0
  fi
}

# =============================================================================
# Execution
# =============================================================================

# Parse arguments
STACKS_TO_DESTROY=()
SKIP_CONFIRMATION=false

for arg in "$@"; do
  case "$arg" in
    --help|-h) show_help ;;
    --skip-confirmation) SKIP_CONFIRMATION=true ;;
    account-pool|idc|data|compute) STACKS_TO_DESTROY+=("$arg") ;;
    all) STACKS_TO_DESTROY=(compute data idc account-pool) ;;
    *)
      printf "${RED}Unknown argument: %s${NC}\n" "$arg"
      printf "Usage: %s [account-pool|idc|data|compute|all] [--skip-confirmation] [--help]\n" "$0"
      exit 1
      ;;
  esac
done

# Default to all stacks in reverse order
if [ ${#STACKS_TO_DESTROY[@]} -eq 0 ]; then
  STACKS_TO_DESTROY=(compute data idc account-pool)
fi

check_dependencies
load_env
resolve_stack_names
validate_required_vars

# Confirmation
if [ "$SKIP_CONFIRMATION" = false ]; then
  show_confirmation
fi

# Destroy
printf "\n"
log_info "Starting destroy..."
printf "\n"

SUCCEEDED_STACKS=()
FAILED_STACK=""

for stack in "${STACKS_TO_DESTROY[@]}"; do
  DISPLAY_NAME=$(get_stack_name "$stack")

  log_info "Destroying ${DISPLAY_NAME}..."
  DESTROY_START=$(date +%s)

  set +e
  destroy_stack "$stack"
  DESTROY_EXIT=$?
  set -e

  DESTROY_DURATION=$(( $(date +%s) - DESTROY_START ))

  if [ $DESTROY_EXIT -ne 0 ]; then
    FAILED_STACK="$stack"
    log_err "${DISPLAY_NAME} FAILED (${DESTROY_DURATION}s)"
    break
  fi

  SUCCEEDED_STACKS+=("$stack")
  log_ok "${DISPLAY_NAME} destroyed (${DESTROY_DURATION}s)"
  printf "\n"
done

print_summary "Destroy" "${STACKS_TO_DESTROY[@]}"
if [ -n "$FAILED_STACK" ]; then exit 1; fi
