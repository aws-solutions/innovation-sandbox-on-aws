// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  SandboxSpacesTokenUsage,
  SandboxSpacesUsageStore,
} from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/sandbox-spaces-usage-store.js";
import { Logger } from "@aws-lambda-powertools/logger";

export interface SandboxSpacesUsageServices {
  sandboxSpacesUsageStore: SandboxSpacesUsageStore;
  logger: Logger;
}

/** Per-1K-token USD rates a turn is priced at, read from the model's catalog row. */
export interface ModelTokenRates {
  inputPricePer1KTokens: number;
  outputPricePer1KTokens: number;
  /** Defaults to the input rate when not published. */
  cacheReadPricePer1KTokens?: number;
  /** Defaults to the input rate when not published. */
  cacheWritePricePer1KTokens?: number;
}

/** A lease's Sandbox Spaces estimated token cost split by user, as the caller is allowed to see it. */
export interface LeaseSandboxSpacesUsageBreakdown {
  /** Per-user accumulated estimated token cost in USD. */
  spendByUsers: {
    userId: string;
    sandboxSpacesEstimatedTokenCostAccrued: number;
  }[];
}

export interface RecordSandboxSpacesTurnUsageProps {
  /** Lease UUID the turn's usage is recorded against. */
  leaseId: string;
  userId: string;
  userEmail: string;
  messageId: string;
  month: string;
  modelId: string;
  tokens: SandboxSpacesTokenUsage;
  /** USD this turn priced to. */
  sandboxSpacesEstimatedTokenCostAccrued: number;
  sessionId?: string;
}
