// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Domain function module for Sandbox Agent operations
 *
 * This module owns the Worker Lambda's core logic: validation, routing,
 * and the postToConnection streaming contract.
 */

import {
  AGENT_KEEP_ALIVE_TOKEN,
  AGENT_PROTOCOL_VERSION,
  AgentError,
  AgentResponse,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/sandbox-agent.types.js";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  type Event as AgentCoreEvent,
  type PayloadType,
} from "@aws-sdk/client-bedrock-agentcore";

import { PersistedAgentModelCatalogRow } from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import { type PersistedLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { validateRequestedModelId } from "@amzn/innovation-sandbox-commons/isb-services/agent-models/index.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { AgentConfig } from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  getCurrentLeaseSpend,
  isActiveLease,
  type LeaseKey,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import { IsbRole } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

export interface ConnectionContext {
  connectionId: string;
  actorId: string;
  role: IsbRole;
  email: string;
  userId: string;
  protocolVersion: number;
}

export interface ValidateAndRouteServices {
  leaseStore: LeaseStore;
  logger: Logger;
}

export interface ValidateAndRouteInput {
  connection: ConnectionContext;
  leaseKey: LeaseKey;
  agentConfig: AgentConfig;
  /**
   * The model the client selected for this turn. Re-validated server-side
   * against its catalog row and the lease's allowed subset, so a crafted
   * request that bypasses the UI is rejected before the runtime is invoked.
   */
  requestedModelId: string;
  /** Catalog row for `requestedModelId`; undefined when it is not in the catalog. */
  requestedModel: PersistedAgentModelCatalogRow | undefined;
}

export interface ValidateAndRouteResult {
  accountId?: string;
  /** The lease's current spend from `getCurrentLeaseSpend`, read before the turn runs. */
  leaseCurrentSpend: number;
  /** `<leaseUuid>_<userId>` — one AgentCore runtime session per caller and lease. */
  runtimeSessionId: string;
}

export class FeatureDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureDisabledError";
  }
}

export class LeaseNotActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseNotActiveError";
  }
}

/**
 * The turn's requested model is not enabled in the catalog, or not in the
 * lease's allowed subset. The message is intentionally generic — the offending
 * model ID is logged server-side but never surfaced to the client.
 */
export class ModelNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelNotAllowedError";
  }
}

/**
 * Reads the lease by its owner-keyed key and returns it only when the caller is
 * a USER entry in its desiredAssignments. Group assignments are not allowed to
 * access. The CLI permission set is resolved from persisted assignments separately.
 */
export async function resolveCallerLease(
  props: { leaseKey: LeaseKey; userId: string },
  services: ValidateAndRouteServices,
): Promise<PersistedLease | undefined> {
  const leaseResult = await services.leaseStore.get(props.leaseKey, {
    consistentRead: true,
  });
  if (leaseResult.error) {
    services.logger.warn(LogPatterns.DataValidationWarning.pattern, {
      error: leaseResult.error,
    });
  }

  const lease = leaseResult.result;
  return lease?.desiredAssignments?.some(
    (assignment) =>
      assignment.principalType === "USER" &&
      assignment.principalId === props.userId,
  )
    ? lease
    : undefined;
}

/**
 * Validates the incoming message and routes it to a lease-bound execution context.
 * Enforces the feature toggle, lease validity, and the requested model's catalog row.
 * There is no monthly token budget or per-message input cap.
 */
export async function validateAndRoute(
  input: ValidateAndRouteInput,
  services: ValidateAndRouteServices,
): Promise<ValidateAndRouteResult> {
  const {
    connection,
    leaseKey,
    agentConfig,
    requestedModelId,
    requestedModel,
  } = input;
  const { logger } = services;
  const { actorId, userId } = connection;
  const leaseId = leaseKey.uuid;

  if (!agentConfig.sandboxSpacesEnabled) {
    throw new FeatureDisabledError("Sandbox Spaces is not enabled.");
  }

  // Owner or direct assignee only — no group access and no Admin ownership bypass.
  const lease = await resolveCallerLease({ leaseKey, userId }, services);

  if (!lease) {
    throw new LeaseNotActiveError(
      `Lease ${leaseId} not found. It may have been terminated or never existed.`,
    );
  }

  if (!isActiveLease(lease)) {
    throw new LeaseNotActiveError(
      `Lease ${leaseId} is not active (current status: ${lease.status}). Please request a new lease.`,
    );
  }

  if (!lease.awsAccountId) {
    throw new LeaseNotActiveError(
      `Lease ${leaseId} has no associated AWS account.`,
    );
  }

  if (!lease.sandboxSpacesEnabled) {
    throw new FeatureDisabledError(
      "Sandbox Space is not enabled for this lease.",
    );
  }

  // Server-side model gate: the request must reference an enabled catalog model
  // and, when the lease carries a subset snapshot, one of those IDs. Enforced
  // here — before the runtime is invoked — so a crafted request that bypasses
  // the UI cannot reach a disabled or disallowed model.
  // An enabled requested row also proves at least one catalog model is enabled.
  const modelValidation = validateRequestedModelId({
    requestedModelId,
    enabledModelIds: requestedModel?.enabled ? [requestedModel.modelId] : [],
    leaseAllowedModelIds: lease.allowedModelIds,
  });
  if (!modelValidation.isValid) {
    logger.warn("Rejected turn — requested model not allowed", {
      actorId,
      leaseId,
      requestedModelId,
      reason: modelValidation.reason,
    });
    throw new ModelNotAllowedError(
      "The requested model is not available for this Sandbox Space.",
    );
  }

  logger.info("Routing to lease-bound Sandbox Space", {
    actorId,
    leaseId,
    accountId: lease.awsAccountId,
  });

  return {
    accountId: lease.awsAccountId,
    leaseCurrentSpend: getCurrentLeaseSpend(lease),
    runtimeSessionId: `${leaseId}_${userId}`,
  };
}

/**
 * Sends a typed AgentResponse to a WebSocket client via the API Gateway
 * Management API. The `send` function is injected so this can be unit-tested
 * without a real client.
 */
export async function sendToConnection(
  connectionId: string,
  payload: AgentResponse,
  send: (connectionId: string, data: string) => Promise<void>,
  logger: Logger,
): Promise<void> {
  try {
    await send(connectionId, JSON.stringify(payload));
  } catch (err: unknown) {
    // GoneException means the client disconnected — not an error.
    const name = (err as { name?: string }).name ?? "";
    if (name === "GoneException") {
      logger.warn("postToConnection: client disconnected (GoneException)", {
        connectionId,
      });
      return;
    }
    throw err;
  }
}

/** Sends a keep-alive token to prevent WebSocket idle timeout during processing. */
export async function sendKeepAlive(
  connectionId: string,
  send: (connectionId: string, data: string) => Promise<void>,
  logger: Logger,
): Promise<void> {
  await sendToConnection(
    connectionId,
    {
      version: AGENT_PROTOCOL_VERSION,
      type: "chunk",
      data: AGENT_KEEP_ALIVE_TOKEN,
    },
    send,
    logger,
  );
}

export type TerminalSpendFields = Pick<
  AgentResponse,
  "callerSandboxSpacesEstimatedTokenCostAccrued" | "leaseCurrentSpend"
>;

/** Sends a typed error response to the client. */
export async function sendError(
  connectionId: string,
  error: AgentError,
  send: (connectionId: string, data: string) => Promise<void>,
  logger: Logger,
  responseFields: TerminalSpendFields = {},
): Promise<void> {
  await sendToConnection(
    connectionId,
    {
      version: AGENT_PROTOCOL_VERSION,
      type: "error",
      error,
      ...responseFields,
    },
    send,
    logger,
  );
}

/** Extracts the memory resource ID from a full ARN (last path segment). */
export function memoryIdFromArn(arn: string): string {
  return arn.split("/").pop() ?? arn;
}

/**
 * Maps one AgentCore payload to a conversational message. Tool calls, tool
 * results, system events, and unsupported roles return null.
 */
function mapMemoryPayloadToMessage(
  payload: PayloadType,
): { role: "user" | "assistant"; content: string } | null {
  if (!("conversational" in payload) || !payload.conversational) return null;
  const { role, content } = payload.conversational;
  if (!role || !content) return null;
  if (role !== "USER" && role !== "ASSISTANT") return null;
  const text = "text" in content ? content.text : null;
  if (!text) return null;
  return { role: role === "USER" ? "user" : "assistant", content: text };
}

export interface MemoryHistoryMessage {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

/**
 * Maps AgentCore events into stable history messages. The payload's original
 * event position remains part of the ID even when unsupported payloads skip.
 */
export function mapMemoryEventsToHistoryMessages(
  events: AgentCoreEvent[],
): MemoryHistoryMessage[] {
  return events.flatMap((event) => {
    if (!event.eventId || !event.eventTimestamp) {
      return [];
    }

    const createdAt = event.eventTimestamp;
    return (event.payload ?? []).flatMap((payload, payloadIndex) => {
      const message = mapMemoryPayloadToMessage(payload);
      return message
        ? [
            {
              messageId: `${event.eventId}:${payloadIndex}`,
              role: message.role,
              content: message.content,
              createdAt,
            },
          ]
        : [];
    });
  });
}

export function mapMemoryEventsToMessages(
  events: AgentCoreEvent[],
): { role: "user" | "assistant"; content: string }[] {
  return events.flatMap((event) =>
    (event.payload ?? [])
      .map((payload) => mapMemoryPayloadToMessage(payload))
      .filter(
        (m): m is { role: "user" | "assistant"; content: string } => m !== null,
      ),
  );
}
