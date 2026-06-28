// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ButtonDropdown } from "@cloudscape-design/components";
import { FC } from "react";

import {
  DevRoleOverride,
  useDevRole,
} from "@amzn/innovation-sandbox-frontend/hooks/useDevRole";

const ROLE_OPTIONS: { id: DevRoleOverride; text: string }[] = [
  { id: "none", text: "Default (no override)" },
  { id: "User", text: "User" },
  { id: "Manager", text: "Manager" },
  { id: "Admin", text: "Admin" },
];

export const DevRoleSwitcher: FC = () => {
  const { activeRole, setActiveRole, isDevModeEnabled } = useDevRole();

  if (!isDevModeEnabled) {
    return null;
  }

  const activeLabel =
    activeRole === "none" ? "Role: Default" : `Role: ${activeRole}`;

  return (
    <ButtonDropdown
      variant="normal"
      items={ROLE_OPTIONS.map((option) => ({
        id: option.id,
        text: option.text,
        iconName: option.id === activeRole ? "check" : undefined,
      }))}
      onItemClick={({ detail }) => {
        setActiveRole(detail.id as DevRoleOverride);
      }}
    >
      {activeLabel}
    </ButtonDropdown>
  );
};
