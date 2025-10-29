// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from "@tanstack/react-query";

import { AuthService } from "@amzn/innovation-sandbox-frontend/helpers/AuthService";

/**
 * Hook to get current user information and role-based flags
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

  const roles = user?.roles || [];

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
