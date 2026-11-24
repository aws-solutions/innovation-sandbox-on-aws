#!/bin/bash
#
# Prepares the aws-nuke config for a cleanup run: merges the ISB overlay into the
# customer's config, substitutes the %PLACEHOLDER% tokens, and appends the managed
# regions.
#
# ISB-required entries live in a separate overlay rather than in the shipped nuke
# config, because that config becomes an AppConfig hosted configuration the customer
# is expected to customize — a release editing it would supersede their edits. The
# overlay ships in this image beside the aws-nuke binary because its keys are Nuke
# resource-type identifiers and must move with the Nuke version.
#
# Not idempotent: it runs once per build against a freshly fetched config. Re-running
# would append a second account block, since the overlay's %CLEANUP_ACCOUNT_ID% key
# would no longer match the substituted key in the config.
#
# Usage:
#   isb-prepare-nuke-config --config <path> --account-id <id> --hub-account-id <id> \
#                           --role-name <name> --namespace <namespace> \
#                           --regions <comma-separated>
set -eo pipefail

OVERLAY=${ISB_NUKE_OVERLAY_PATH:-/opt/isb/nuke-config.isb-overlay.yaml}

CONFIG=""
ACCOUNT_ID=""
HUB_ACCOUNT_ID=""
ROLE_NAME=""
NAMESPACE=""
REGIONS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG="$2"; shift 2 ;;
    --account-id) ACCOUNT_ID="$2"; shift 2 ;;
    --hub-account-id) HUB_ACCOUNT_ID="$2"; shift 2 ;;
    --role-name) ROLE_NAME="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --regions) REGIONS="$2"; shift 2 ;;
    *) echo "isb-prepare-nuke-config: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

for REQUIRED in CONFIG ACCOUNT_ID HUB_ACCOUNT_ID ROLE_NAME NAMESPACE REGIONS; do
  eval "VALUE=\$$REQUIRED"
  [ -n "$VALUE" ] || {
    echo "isb-prepare-nuke-config: missing required argument for $REQUIRED" >&2
    exit 2
  }
done

for FILE in "$CONFIG" "$OVERLAY"; do
  [ -f "$FILE" ] || {
    echo "isb-prepare-nuke-config: file not found: $FILE" >&2
    exit 2
  }
done

# Merge before substituting, so both documents still share the %CLEANUP_ACCOUNT_ID%
# account key and the tokens can be replaced in one pass afterwards.
#
# `*+` deep-merges maps and appends sequences; `unique` then drops duplicates so an
# entry the customer already added is not doubled. The overlay's file header is
# stripped so the merge does not prepend it to the customer's config; its per-entry
# comments are kept and explain each ISB entry in the build log. The strip needs its
# own yq call — folding it into the merge expression leaves the header in the output.
yq '. head_comment = ""' "$OVERLAY" \
  | yq eval-all -i \
      'select(fileIndex==0) *+ select(fileIndex==1) | (.. | select(tag == "!!seq")) |= (map(... line_comment="") | unique)' \
      "$CONFIG" -

sed -i \
  -e "s/%HUB_ACCOUNT_ID%/${HUB_ACCOUNT_ID}/g" \
  -e "s/%CLEANUP_ACCOUNT_ID%/${ACCOUNT_ID}/g" \
  -e "s/%CLEANUP_ROLE_NAME%/${ROLE_NAME}/g" \
  -e "s/%NAMESPACE%/${NAMESPACE}/g" \
  "$CONFIG"

# The shipped config carries `regions: [global]`; the rest come from the account pool
# config at runtime.
for REGION in $(echo "$REGIONS" | tr ',' ' '); do
  [ -n "$REGION" ] || continue
  REGION="$REGION" yq -i '.regions += [env(REGION)] | .regions |= unique' "$CONFIG"
done

echo "isb-prepare-nuke-config: prepared $CONFIG"
