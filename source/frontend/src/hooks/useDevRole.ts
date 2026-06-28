// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, useState } from "react";

import { IsbRole } from "@amzn/innovation-sandbox-commons/types/isb-types";
import { isDevMode } from "@amzn/innovation-sandbox-frontend/helpers/config";

const DEV_ROLE_STORAGE_KEY = "isb-dev-role";

export type DevRoleOverride = IsbRole | "none";

export interface DevRoleContextType {
  activeRole: DevRoleOverride;
  setActiveRole: (role: DevRoleOverride) => void;
  isDevModeEnabled: boolean;
}

export const DevRoleContext = createContext<DevRoleContextType>({
  activeRole: "none",
  setActiveRole: () => {},
  isDevModeEnabled: false,
});

export const useDevRoleState = (): DevRoleContextType => {
  const isDevModeEnabled = isDevMode();

  const getInitialRole = (): DevRoleOverride => {
    if (!isDevModeEnabled) return "none";
    const stored = localStorage.getItem(DEV_ROLE_STORAGE_KEY);
    if (stored === "Admin" || stored === "Manager" || stored === "User") {
      return stored;
    }
    return "none";
  };

  const [activeRole, setActiveRoleState] = useState<DevRoleOverride>(getInitialRole);

  const setActiveRole = (role: DevRoleOverride) => {
    setActiveRoleState(role);
    if (role === "none") {
      localStorage.removeItem(DEV_ROLE_STORAGE_KEY);
    } else {
      localStorage.setItem(DEV_ROLE_STORAGE_KEY, role);
    }
  };

  return {
    activeRole,
    setActiveRole,
    isDevModeEnabled,
  };
};

export const useDevRole = (): DevRoleContextType => useContext(DevRoleContext);
