// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useAssignmentPermissionSets } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/useAssignmentPermissionSets";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

const permissionSet = (
  name: string,
  suffix: string,
  availability: PermissionSetReference["availability"] = "AVAILABLE",
): PermissionSetReference => ({
  permissionSetArn: `arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-${suffix.padEnd(16, "0")}`,
  permissionSetId: `ps-${suffix.padEnd(16, "0")}`,
  name,
  availability,
});

describe("useAssignmentPermissionSets", () => {
  it("orders the default first and the remaining permission sets by label", () => {
    const defaultPermissionSet = permissionSet("Developer", "developer");
    const auditorPermissionSet = permissionSet("Auditor", "auditor");
    const readOnlyPermissionSet = permissionSet("Read only", "readonly");
    const unavailablePermissionSet = permissionSet(
      "Billing",
      "billing",
      "UNAVAILABLE",
    );

    const { result } = renderHook(() =>
      useAssignmentPermissionSets(defaultPermissionSet, [
        readOnlyPermissionSet,
        unavailablePermissionSet,
        defaultPermissionSet,
        auditorPermissionSet,
      ]),
    );

    expect(
      result.current.assignablePermissionSets.map(({ name }) => name),
    ).toEqual(["Developer", "Auditor", "Read only"]);
    expect(
      result.current.permissionSetOptions.map(({ label }) => label),
    ).toEqual(["Developer", "Auditor", "Billing", "Read only"]);
  });
});
