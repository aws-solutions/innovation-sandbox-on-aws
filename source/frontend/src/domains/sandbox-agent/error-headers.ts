// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentErrorCode } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";

export const AGENT_ERROR_HEADERS = {
  CONNECTION_INTERRUPTED: "Connection interrupted",
  CONTENT_FILTERED: "Content filter stopped the reply",
  FEATURE_DISABLED: "Sandbox Spaces not available",
  INPUT_BLOCKED: "Safety filter blocked the message",
  INVALID_REQUEST: "Request can't be processed",
  LEASE_NOT_ACTIVE: "Sandbox Space not active",
  MESSAGE_TOO_LARGE: "Message too long",
  MODEL_SERVICE_UNAVAILABLE: "Model service unavailable",
  MODEL_STREAM_ENDED: "Reply cut off",
  MODEL_THROTTLED: "Model is busy",
  MODEL_TIMED_OUT: "Model timed out",
  RUNTIME_ERROR: "Something went wrong",
  SESSION_EXPIRED: "Session expired",
  TIME_LIMIT: "Time limit reached",
  TURN_IN_PROGRESS: "Request already in progress",
  UNKNOWN_ERROR: "Something went wrong",
} as const satisfies Record<AgentErrorCode, string>;
