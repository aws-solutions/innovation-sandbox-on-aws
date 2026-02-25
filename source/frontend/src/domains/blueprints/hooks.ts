// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { BlueprintService } from "@amzn/innovation-sandbox-frontend/domains/blueprints/service";
import {
  RegisterBlueprintRequest,
  UpdateBlueprintRequest,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";

export const useGetBlueprints = () => {
  return useQuery({
    queryKey: ["blueprints"],
    queryFn: async () => await new BlueprintService().getBlueprints(),
  });
};

export const useGetBlueprintById = (blueprintId?: string | null) => {
  return useQuery({
    queryKey: ["blueprints", blueprintId],
    queryFn: async () =>
      await new BlueprintService().getBlueprintById(blueprintId!),
    enabled: !!blueprintId,
  });
};

export const useRegisterBlueprint = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (blueprint: RegisterBlueprintRequest) =>
      await new BlueprintService().registerBlueprint(blueprint),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["blueprints"],
        refetchType: "all",
      }),
  });
};

export const useUpdateBlueprint = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
    }: {
      id: string;
      updates: UpdateBlueprintRequest;
    }) => await new BlueprintService().updateBlueprint(id, updates),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["blueprints"],
        refetchType: "all",
      }),
  });
};

export const useUnregisterBlueprint = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (blueprintId: string) =>
      await new BlueprintService().unregisterBlueprint(blueprintId),
    onSuccess: () =>
      client.invalidateQueries({
        queryKey: ["blueprints"],
        refetchType: "all",
      }),
  });
};

export const useUnregisterBlueprints = (options?: {
  skipInvalidation?: boolean;
}) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (blueprintIds: string[]) =>
      await new BlueprintService().unregisterBlueprints(blueprintIds),
    onSuccess: () => {
      if (!options?.skipInvalidation) {
        client.invalidateQueries({
          queryKey: ["blueprints"],
          refetchType: "all",
        });
      }
    },
  });
};

export const useListStackSets = (params?: {
  pageIdentifier?: string;
  pageSize?: number;
}) => {
  return useQuery({
    queryKey: ["stacksets", params],
    queryFn: async () => await new BlueprintService().listStackSets(params),
    staleTime: 5 * 60 * 1000, // 5 minutes - StackSets are relatively static
  });
};
