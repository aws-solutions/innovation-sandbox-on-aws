// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";

import { IsbRole } from "@amzn/innovation-sandbox-commons/types/isb-types";
import { AuthService } from "@amzn/innovation-sandbox-frontend/helpers/AuthService";
import { useDevRole } from "@amzn/innovation-sandbox-frontend/hooks/useDevRole";

/**
 * Hook to get current user information and role-based flags.
 * When DEPLOYMENT_MODE is "dev" and a dev role override is active,
 * the roles are replaced with the selected role to allow perspective switching.
 */
export const useUser = () => {
  const {
    data: user,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["currentUser"],
    queryFn: async () => {
      const user = await AuthService.getCurrentUser();
      // React Query requires non-undefined return values
      return user ?? null;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1,
  });

  const { activeRole, isDevModeEnabled } = useDevRole();

  const actualRoles = user?.roles || [];

  // Apply dev role override: replace roles with the selected dev role
  const roles: IsbRole[] =
    isDevModeEnabled && activeRole !== "none" ? [activeRole] : actualRoles;

  return {
    user: user || undefined, // Convert null back to undefined for API consistency
    roles,
    isLoading,
    error,
    isAdmin: roles.includes("Admin"),
    isManager: roles.includes("Manager"),
    isUser: roles.includes("User"),
  };
};
