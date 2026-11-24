// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";

import { CognitoAuthService } from "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService";

export type { IdcIdentity } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

/**
 * Hook to get current user information and role-based flags.
 */
export const useUser = () => {
  const {
    data: authResult,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => CognitoAuthService.getCurrentUser(),
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 1,
  });

  const user =
    authResult?.status === "authenticated" ? authResult.user : undefined;
  const authError =
    authResult?.status === "incomplete_claims" ? authResult.message : undefined;
  const roles = user?.roles || [];

  return {
    user,
    authError,
    roles,
    isLoading,
    error,
    isAdmin: roles.includes("Admin"),
    isManager: roles.includes("Manager"),
    isUser: roles.includes("User"),
  };
};
