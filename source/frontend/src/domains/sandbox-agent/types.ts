// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Frontend-owned read models parsed at the Smithy adapter boundary.
export type {
  SandboxSpacesUsageView,
  SandboxSpacesUserSpendView,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/model";
// Shared WebSocket and history contracts; frontend-only render models follow.
export type {
  AgentError,
  AgentErrorCode,
  AgentHistoryMessage,
  AgentHistoryResponse,
  AgentRequest,
  AgentResponse,
  AgentResponseType,
  ConversationMessage,
  ToolUsage,
  ToolUsageStatus,
} from "@amzn/innovation-sandbox-shared/types/sandbox-agent.js";

// Frontend-owned aliases for the model-catalog enums. Per ADR-0017 the
// generated api-client enums stay inside `smithy-client.ts`; the frontend
// domain owns its own string-union representation. The generated enum values
// are structurally assignable to these unions, so the adapter can map straight
// through without a cast.
//
// `modelType` is the authoritative discriminator for how a model was
// discovered (a Bedrock foundation model vs. a system-defined inference
// profile) and is used to render the Type column in the enable-models flow.
export type AgentModelType = "foundation-model" | "inference-profile";
export type AgentModelPricingSource = "agreement-offers" | "price-list";

import type {
  AgentErrorCode,
  AgentHistoryMessage,
  ToolUsage,
} from "@amzn/innovation-sandbox-shared/types/sandbox-agent.js";

/** A rendered chat bubble, as opposed to a raw `AgentResponse` wire chunk. */
export type DisplayMessage =
  | HistoryDisplayMessage
  | StreamingDisplayMessage
  | ToolUseDisplayMessage
  | ErrorDisplayMessage;

export type HistoryDisplayMessage = {
  kind: "history";
  messageId: AgentHistoryMessage["messageId"];
  role: AgentHistoryMessage["role"];
  content: AgentHistoryMessage["content"];
  createdAt: AgentHistoryMessage["createdAt"];
};

export type StreamingDisplayMessage = {
  kind: "streaming";
  role: "assistant";
  content: string;
  conversationId?: string;
  messageId: string;
  isComplete: boolean;
  /** Browser time the response completed; absent while it streams. */
  createdAt?: HistoryDisplayMessage["createdAt"];
};

export type ToolUseDisplayMessage = {
  kind: "tool_use";
  toolUsage: ToolUsage;
  conversationId?: string;
  messageId?: string;
};

export type ErrorDisplayMessage = {
  kind: "error";
  messageId: string;
  code?: AgentErrorCode;
  message?: string;
  retryable?: boolean;
  conversationId?: string;
};

/** Variants the current chat renderer explicitly supports. */
export type ChatRenderableMessage = Extract<
  DisplayMessage,
  { kind: "history" | "streaming" | "error" }
>;

export type AgentConnectionStatus = "connecting" | "connected" | "reconnecting";

/**
 * A selectable agent model from `GET /sandboxAgent/models`. That endpoint
 * returns only globally-enabled models, so there is no `enabled` flag to filter
 * on. `modelId`/`displayName` are guaranteed present (the adapter drops any row
 * missing an id and falls back the display name to the id).
 */
export type AgentModel = {
  modelId: string;
  displayName: string;
  provider?: string;
  availability?: string;
  description?: string;
};

export type AgentModelRates = {
  inputPricePer1KTokens?: number;
  outputPricePer1KTokens?: number;
  cacheReadPricePer1KTokens?: number;
  cacheWritePricePer1KTokens?: number;
};

/**
 * A model discovered live from Bedrock via `GET /sandboxAgent/models`, used by
 * the admin enable-models flow. Distinct from a persisted catalog row: it has
 * no `enabled` flag and no OCC token because it is not yet in the catalog. The
 * adapter drops any row missing an id or `modelType` and falls the display name
 * back to the id.
 */
export type AgentModelDiscoveryEntry = AgentModelRates & {
  modelId: string;
  displayName: string;
  provider: string;
  availability: string;
  description?: string;
  /** Whether Bedrock discovered this as a foundation model or an inference profile. */
  modelType: AgentModelType;
  /** Foundation model this entry invokes; its own ID for a foundation model. */
  foundationModelId?: string;
  foundationModelName?: string;
  pricingSource?: AgentModelPricingSource;
  /** ISO 8601 instant of this pricing fetch. */
  pricingRefreshedAt?: string;
};

/**
 * A persisted catalog row from `GET /configurations/agent/models`. Unlike a
 * discovery entry it carries the admin `enabled` flag and the `meta.lastEditTime`
 * OCC token an enable/disable write must echo back. Pricing fields are optional:
 * a model with no stored price has none.
 */
export type AgentModelCatalogEntry = AgentModelRates & {
  modelId: string;
  displayName: string;
  provider: string;
  availability: string;
  description?: string;
  modelType?: AgentModelType;
  /** Foundation model this entry invokes; its own ID for a foundation model. */
  foundationModelId?: string;
  foundationModelName?: string;
  pricingSource?: AgentModelPricingSource;
  pricingRefreshedAt?: string;
  enabled: boolean;
  addedAt: string;
  lastSavedBy: string;
  /** OCC envelope; `lastEditTime` is the token an enable/disable write echoes. */
  meta: { createdTime: string; lastEditTime: string };
};

/**
 * The fields an enable/disable write sends to `PUT /configurations/agent/models`.
 * The backend resolves model metadata from Bedrock on create and preserves it
 * on update. To create a row, omit `expectedLastEditTime` and send `modelType`;
 * to toggle `enabled` under OCC, send `expectedLastEditTime` and no `modelType`.
 */
export type AgentModelCatalogUpsert = {
  modelId: string;
  enabled: boolean;
  expectedLastEditTime?: string;
  modelType?: AgentModelType;
};
