// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AccountService } from "@amzn/innovation-sandbox-frontend/domains/accounts/service";

export const useGetAccounts = () => {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: async () => await new AccountService().getAccounts(),
  });
};

export const useGetUnregisteredAccounts = () => {
  return useQuery({
    queryKey: ["unregisteredAccounts"],
    queryFn: async () => await new AccountService().getUnregisteredAccounts(),
  });
};

export const useAddAccount = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (awsAccountId: string) =>
      await new AccountService().addAccount(awsAccountId),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["accounts"], refetchType: "all" });
      client.invalidateQueries({
        queryKey: ["unregisteredAccounts"],
        refetchType: "all",
      });
    },
  });
};

export const useEjectAccount = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (awsAccountId: string) =>
      await new AccountService().ejectAccount(awsAccountId),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["accounts"], refetchType: "all" });
      client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
    },
  });
};

export const useCleanupAccount = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (awsAccountId: string) =>
      await new AccountService().cleanupAccount(awsAccountId),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["accounts"], refetchType: "all" }),
  });
};

export const useQuarantineAccount = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (awsAccountId: string) =>
      await new AccountService().quarantineAccount(awsAccountId),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["accounts"], refetchType: "all" });
      client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
    },
  });
};
