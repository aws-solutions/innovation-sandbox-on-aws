// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { getSandboxAgentService } from "./service";
import type { AgentModelCatalogUpsert } from "./types";

export const AGENT_MODEL_CATALOG_KEY = ["agentModelCatalog"] as const;
export const SANDBOX_SPACES_USAGE_KEY = ["sandbox-agent", "usage"] as const;
const AGENT_MODELS_KEY = ["agentModels"] as const;

export const useAgentModels = (options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: AGENT_MODELS_KEY,
    queryFn: async () => await getSandboxAgentService().listModels(),
    // Callers gate this on the Sandbox Spaces toggle so the catalog is only
    // fetched when a model picker is actually shown.
    enabled: options?.enabled ?? true,
  });
};

export const useSandboxSpacesUsage = (leaseId: string, userId: string) => {
  return useQuery({
    queryKey: [...SANDBOX_SPACES_USAGE_KEY, leaseId, userId],
    queryFn: async () => await getSandboxAgentService().getUsage(leaseId),
    enabled: !!leaseId && !!userId,
    refetchOnMount: "always",
  });
};

/**
 * Every persisted catalog row (enabled and disabled), for the admin catalog
 * table. Distinct from `useAgentModels`, which returns only the models a lease
 * user may pick. staleTime: 0 keeps the OCC tokens the enable/disable writes
 * echo always fresh.
 */
export const useAgentModelCatalog = (options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: AGENT_MODEL_CATALOG_KEY,
    queryFn: async () => await getSandboxAgentService().listCatalog(),
    enabled: options?.enabled ?? true,
    staleTime: 0,
  });
};

/**
 * The enabled persisted catalog rows, mapped to the lease-template model
 * picker's option shape. Sourced from the catalog (not live discovery) so the
 * picker only ever offers models an admin has curated and enabled.
 */
export const useEnabledCatalogModels = (options?: { enabled?: boolean }) => {
  const query = useAgentModelCatalog(options);
  const enabledModels = useMemo(
    () => (query.data ?? []).filter((model) => model.enabled),
    [query.data],
  );
  return { ...query, data: enabledModels, catalog: query.data };
};

/**
 * Live Bedrock discovery for the admin enable-models flow. Not fetched until a
 * caller enables it (the discovery dialog opens), because it makes live Bedrock
 * API calls; the result is not cached across dialog opens so a re-open always
 * reflects the current Bedrock catalog.
 */
export const useAgentModelDiscovery = (options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ["agentModelDiscovery"],
    queryFn: async () => await getSandboxAgentService().discoverModels(),
    enabled: options?.enabled ?? false,
    gcTime: 0,
    staleTime: 0,
  });
};

/**
 * Create or toggle a catalog row. On success invalidates the catalog and the
 * enabled-models list so the table, the template picker, and the global-setting
 * gate all refetch. Pass `skipInvalidation: true` for bulk operations that do a
 * single invalidation after `Promise.allSettled` rather than one per call.
 */
export const usePutAgentModelCatalogEntry = (options?: {
  skipInvalidation?: boolean;
}) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: AgentModelCatalogUpsert) =>
      await getSandboxAgentService().putCatalogEntry(input),
    onSuccess: () => {
      if (options?.skipInvalidation) return;
      client.invalidateQueries({ queryKey: AGENT_MODEL_CATALOG_KEY });
      client.invalidateQueries({ queryKey: AGENT_MODELS_KEY });
    },
  });
};
