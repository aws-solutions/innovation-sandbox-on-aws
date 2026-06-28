#!/usr/bin/env bash
# Licensed under the Apache License, Version 2.0 (the "License").
# You may not use this file except in compliance with the License.
# A copy of the License is located at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# or in the "license" file accompanying this file. This file is distributed
# on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
# express or implied. See the License for the specific language governing
# permissions and limitations under the License.

set -euo pipefail

UPSTREAM_URL="https://github.com/aws-solutions/innovation-sandbox-on-aws.git"
UPSTREAM_REMOTE="upstream"
BRANCH="${1:-main}"

if ! git remote get-url "$UPSTREAM_REMOTE" &>/dev/null; then
  echo "Adding upstream remote: $UPSTREAM_URL"
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

echo "Fetching from $UPSTREAM_REMOTE..."
git fetch "$UPSTREAM_REMOTE"

echo "Merging $UPSTREAM_REMOTE/$BRANCH into $BRANCH..."
git merge "$UPSTREAM_REMOTE/$BRANCH"

echo "Pushing to origin/$BRANCH..."
git push origin "$BRANCH"

echo "Done. Local $BRANCH is now in sync with upstream."
