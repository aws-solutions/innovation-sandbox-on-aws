// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { LeaseTemplateView } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";
import { useEnabledCatalogModels } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries";

import { getLeaseTemplateService } from "./service";
import { CreateLeaseTemplateRequest } from "./types";

export const useEnabledModelIds = (
  sandboxSpacesSetting: boolean | undefined,
): string[] | undefined => {
  const catalog = useEnabledCatalogModels({
    enabled: sandboxSpacesSetting === true,
  });
  return useMemo(
    () =>
      catalog.isSuccess
        ? catalog.data.map((model) => model.modelId)
        : undefined,
    [catalog.isSuccess, catalog.data],
  );
};

export const useGetLeaseTemplates = () => {
  return useQuery({
    queryKey: ["leaseTemplates"],
    queryFn: async () => await getLeaseTemplateService().getLeaseTemplates(),
  });
};

export const useGetLeaseTemplateById = (uuid?: string) => {
  return useQuery({
    queryKey: ["leaseTemplates", uuid],
    queryFn: async () =>
      await getLeaseTemplateService().getLeaseTemplateById(uuid!),
    enabled: !!uuid,
  });
};

export const useDeleteLeaseTemplates = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseTemplateIds: string[]) =>
      await getLeaseTemplateService().deleteLeaseTemplates(leaseTemplateIds),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["leaseTemplates"],
        refetchType: "all",
      }),
  });
};

export const useUpdateLeaseTemplate = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseTemplate: LeaseTemplateView) =>
      await getLeaseTemplateService().updateLeaseTemplate(leaseTemplate),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["leaseTemplates"],
        refetchType: "all",
      }),
  });
};

export const useAddLeaseTemplate = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseTemplate: CreateLeaseTemplateRequest) =>
      await getLeaseTemplateService().addLeaseTemplate(leaseTemplate),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["leaseTemplates"],
        refetchType: "all",
      }),
  });
};
