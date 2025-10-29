#!/bin/bash
#
# Common functions for build scripts
# This file should be sourced by other build scripts to provide shared functionality
#

# Color codes for consistent output formatting
export RED="\033[0;31m"      # Error messages
export GREEN="\033[0;32m"    # Success messages
export BLUE="\033[0;34m"     # Info messages
export YELLOW="\033[0;33m"   # Warning messages
export PURPLE="\033[0;35m"   # Step headers
export WHITE="\033[0;37m"    # Values and details (better contrast than cyan)
export BOLD="\033[1m"        # Bold text
export NC="\033[00m"         # No color (reset)

# Get the root directory of the project
# This function should be called from scripts in the deployment/ directory
get_root_dir() {
    dirname "$(dirname "$(realpath "$0")")"
}

# Function to read values from solution-manifest.yaml
# Usage: read_from_manifest "key"
# Returns: The value associated with the key, or empty string if not found
read_from_manifest() {
    local key="$1"
    local root_dir="${2:-$(get_root_dir)}"
    local manifest_file="$root_dir/solution-manifest.yaml"

    if [ -f "$manifest_file" ]; then
        # Use grep and sed to extract the value, handling potential whitespace
        grep "^${key}:" "$manifest_file" | sed "s/^${key}:[[:space:]]*//" | tr -d '"' | tr -d "'"
    fi
}

# Function to set solution parameters from manifest if not provided
# Usage: set_solution_params_from_manifest
# Sets global variables: SOLUTION_NAME, VERSION, SOLUTION_ID if they're empty
set_solution_params_from_manifest() {
    local root_dir="${1:-$(get_root_dir)}"

    # Set SOLUTION_NAME from manifest if not provided
    if [ -z "$SOLUTION_NAME" ]; then
        SOLUTION_NAME=$(read_from_manifest "name" "$root_dir")
        if [ -n "$SOLUTION_NAME" ]; then
            printf "%bSolution name: %b%s%b\n" "${BLUE}" "${WHITE}" "$SOLUTION_NAME" "${NC}"
        fi
    fi

    # Set VERSION from manifest if not provided
    if [ -z "$VERSION" ]; then
        VERSION=$(read_from_manifest "version" "$root_dir")
        if [ -n "$VERSION" ]; then
            printf "%bVersion: %b%s%b\n" "${BLUE}" "${WHITE}" "$VERSION" "${NC}"
        fi
    fi

    # Set SOLUTION_ID from manifest if not provided
    if [ -z "$SOLUTION_ID" ]; then
        SOLUTION_ID=$(read_from_manifest "id" "$root_dir")
        if [ -n "$SOLUTION_ID" ]; then
            printf "%bSolution ID: %b%s%b\n" "${BLUE}" "${WHITE}" "$SOLUTION_ID" "${NC}"
        fi
    fi
}

# Function to validate required parameters
# Usage: validate_required_params "param1" "param2" ...
# Exits with error if any required parameter is empty
validate_required_params() {
    local missing_params=()

    for param_name in "$@"; do
        # Use indirect variable expansion to get the value
        local param_value="${!param_name}"
        if [ -z "$param_value" ]; then
            missing_params+=("$param_name")
        fi
    done

    if [ ${#missing_params[@]} -gt 0 ]; then
        printf "%bError: Missing required parameters: %s\n%b" "${RED}" "${missing_params[*]}" "${NC}"
        return 1
    fi

    return 0
}

# Function to print step headers
# Usage: print_step "Step Name"
print_step() {
    local step="$1"
    printf "\n%b=== %s ===%b\n" "${BOLD}${PURPLE}" "$step" "${NC}"
}

# Function to print info messages
# Usage: print_info "message"
print_info() {
    local message="$1"
    printf "%b  -> %s%b\n" "${BLUE}" "$message" "${NC}"
}

# Function to print success messages
# Usage: print_success "message"
print_success() {
    local message="$1"
    printf "%b  -> %s%b\n" "${GREEN}" "$message" "${NC}"
}

# Function to print final success message with better formatting
# Usage: print_final_success "message"
print_final_success() {
    local message="$1"
    printf "\n%b" "${BOLD}${GREEN}"
    printf "========================================\n"
    printf "  %s\n" "$message"
    printf "========================================%b\n" "${NC}"
}

# Function to print warning messages
# Usage: print_warning "message"
print_warning() {
    local message="$1"
    printf "%b  -> [WARNING] %s%b\n" "${YELLOW}" "$message" "${NC}"
}

# Function to print error messages and exit
# Usage: print_error_and_exit "error message" [exit_code]
print_error_and_exit() {
    local message="$1"
    local exit_code="${2:-1}"
    printf "%b[ERROR] %s%b\n" "${RED}" "$message" "${NC}" >&2
    exit "$exit_code"
}

# Legacy function for backward compatibility
# Usage: print_status "message" [color]
print_status() {
    local message="$1"
    local color="${2:-$BLUE}"
    printf "%b   %s%b\n" "$color" "$message" "${NC}"
}

# Function to create directory if it doesn't exist
# Usage: ensure_directory "path/to/directory"
ensure_directory() {
    local dir_path="$1"
    if [ ! -d "$dir_path" ]; then
        mkdir -p "$dir_path"
        print_info "Created directory: $(basename "$dir_path")"
    fi
}

# Function to remove directory if it exists
# Usage: remove_directory "path/to/directory"
remove_directory() {
    local dir_path="$1"
    if [ -d "$dir_path" ]; then
        rm -rf "$dir_path"
        print_info "Removed directory: $(basename "$dir_path")"
    fi
}

# Function to check if a command exists
# Usage: command_exists "command_name"
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to run a command with status output
# Usage: run_with_status "description" command args...
run_with_status() {
    local description="$1"
    shift  # Remove description, leaving command and args

    print_info "$description..."

    if "$@"; then
        print_success "$description completed"
        return 0
    else
        print_error_and_exit "$description failed"
    fi
}
