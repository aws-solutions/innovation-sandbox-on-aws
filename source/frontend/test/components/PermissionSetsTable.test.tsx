// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PermissionSetsTable } from "@amzn/innovation-sandbox-frontend/components/PermissionSetsTable";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set";

const builtIn: PermissionSetReference = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  permissionSetId: "ps-0123456789abcdef",
  name: "myisb_IsbUsersPS",
  availability: "AVAILABLE",
};
const custom: PermissionSetReference = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
  permissionSetId: "ps-1123456789abcdef",
  name: "ReadOnlyAccess",
  availability: "AVAILABLE",
};

describe("PermissionSetsTable", () => {
  it("labels the built-in set while retaining its technical name and default badge", () => {
    render(
      <PermissionSetsTable
        defaultPermissionSet={builtIn}
        allowedPermissionSets={[builtIn, custom]}
      />,
    );

    const builtInRow = screen.getByText("Full sandbox access").closest("tr")!;
    expect(within(builtInRow).getByText(builtIn.name!)).toBeVisible();
    expect(within(builtInRow).getByText("Default")).toBeVisible();
    expect(screen.getAllByText("Full sandbox access")).toHaveLength(1);
    expect(screen.getByText(custom.name!)).toBeVisible();
  });

  it("keeps the built-in alias separate from a custom default and preserves action references", async () => {
    const onSetDefault = vi.fn();
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(
      <PermissionSetsTable
        defaultPermissionSet={custom}
        allowedPermissionSets={[builtIn]}
        onSetDefaultPermissionSet={onSetDefault}
        onRemoveAllowedPermissionSet={onRemove}
      />,
    );

    const builtInRow = screen.getByText("Full sandbox access").closest("tr")!;
    expect(within(builtInRow).queryByText("Default")).not.toBeInTheDocument();
    expect(screen.getByText("Default").closest("tr")).toHaveTextContent(
      custom.name!,
    );
    await user.click(
      within(builtInRow).getByRole("button", {
        name: /set .* as default permission set/i,
      }),
    );
    expect(onSetDefault).toHaveBeenCalledWith(builtIn);
    await user.click(
      within(builtInRow).getByRole("button", { name: /remove/i }),
    );
    expect(onRemove).toHaveBeenCalledWith(builtIn);
  });

  it("uses the alias for a legacy implicit built-in default", () => {
    render(<PermissionSetsTable />);

    expect(screen.getByText("Full sandbox access")).toBeVisible();
    expect(screen.getByText("Default")).toBeVisible();
  });

  it.each(["ReadOnlyAccess", "myisb_IsbUsersPS_backup", undefined])(
    "does not alias a custom or unidentified default named %s",
    (name) => {
      render(
        <PermissionSetsTable
          defaultPermissionSet={{
            ...custom,
            name,
            availability: "UNAVAILABLE",
          }}
        />,
      );

      expect(screen.queryByText("Full sandbox access")).not.toBeInTheDocument();
      expect(screen.getByText(name ?? custom.permissionSetArn)).toBeVisible();
      expect(screen.getByText("Unavailable")).toBeVisible();
    },
  );
});
