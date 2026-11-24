// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AgentHistoryResponse,
  AgentModel,
  AgentModelCatalogEntry,
  AgentModelCatalogUpsert,
  AgentModelDiscoveryEntry,
  SandboxSpacesUsageView,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";
import { registerApiSingletonReset } from "@amzn/innovation-sandbox-frontend/helpers/apiSingletons";

import {
  createSandboxAgentClient,
  SmithySandboxAgentApi,
  SmithySandboxAgentClient,
} from "./smithy-client";

export interface AgentHistoryService {
  listHistory(
    leaseId: string | undefined,
    nextToken?: string,
    maxResults?: number,
  ): Promise<AgentHistoryResponse>;
  getUsage(leaseId: string): Promise<SandboxSpacesUsageView>;
  listModels(): Promise<AgentModel[]>;

  discoverModels(): Promise<AgentModelDiscoveryEntry[]>;

  listCatalog(): Promise<AgentModelCatalogEntry[]>;

  putCatalogEntry(
    input: AgentModelCatalogUpsert,
  ): Promise<AgentModelCatalogEntry>;
}

export class SandboxAgentService implements AgentHistoryService {
  constructor(private readonly api: SmithySandboxAgentApi) {}

  async listHistory(
    leaseId: string | undefined,
    nextToken?: string,
    maxResults?: number,
  ): Promise<AgentHistoryResponse> {
    return this.api.listHistory(leaseId, nextToken, maxResults);
  }

  async getUsage(leaseId: string): Promise<SandboxSpacesUsageView> {
    return this.api.getSandboxSpacesUsage(leaseId);
  }

  async listModels(): Promise<AgentModel[]> {
    return this.api.listModels();
  }

  async discoverModels(): Promise<AgentModelDiscoveryEntry[]> {
    return this.api.discoverModels();
  }

  async listCatalog(): Promise<AgentModelCatalogEntry[]> {
    return this.api.listCatalog();
  }

  async putCatalogEntry(
    input: AgentModelCatalogUpsert,
  ): Promise<AgentModelCatalogEntry> {
    return this.api.putCatalogEntry(input);
  }
}

let sandboxAgentService: SandboxAgentService | undefined;

// Lazily-initialized singleton.
export function getSandboxAgentService(): SandboxAgentService {
  sandboxAgentService ??= new SandboxAgentService(
    new SmithySandboxAgentClient(createSandboxAgentClient()),
  );
  return sandboxAgentService;
}

registerApiSingletonReset(() => {
  sandboxAgentService = undefined;
});
