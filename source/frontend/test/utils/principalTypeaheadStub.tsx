// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PrincipalTypeaheadProps } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PrincipalTypeahead";
import type { IdcPrincipalView } from "@amzn/innovation-sandbox-frontend/domains/principals/model";

/**
 * Creates a deterministic PrincipalTypeahead replacement for assignment tests.
 * It preserves the caller-visible type and exclusion filtering while replacing
 * Cloudscape Autosuggest with buttons; PrincipalTypeahead behavior is tested in
 * its own suite. The getter delays fixture access until render so Vitest's
 * hoisted mock factory does not evaluate a module-level fixture too early.
 */
export function createPrincipalTypeaheadStub(
  getPrincipals: () => readonly IdcPrincipalView[],
) {
  return function PrincipalTypeaheadStub({
    onSelect,
    shouldExclude = () => false,
    type = "all",
    disabled = false,
  }: PrincipalTypeaheadProps) {
    const principals = getPrincipals();

    return (
      <div data-testid="typeahead-stub" data-search-type={type}>
        {principals
          .filter(
            (principal) =>
              !shouldExclude(principal) &&
              (type === "all" ||
                (type === "users" && principal.principalType === "USER") ||
                (type === "groups" && principal.principalType === "GROUP")),
          )
          .map((principal) => (
            <button
              key={principal.principalId}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(principal)}
            >
              Add {principal.principalId}
            </button>
          ))}
      </div>
    );
  };
}
