// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared scoped-credential module for Sandbox Agent.
 *
 * Assumes the Memory Access Role with a session policy scoping AgentCore Memory
 * access to either:
 *   - one actor's STM on one lease, read-only
 *     ({@link acquireHistoryMemoryCredentials}, used by the History API), or
 *   - every actor's LTM on one lease, list and delete only
 *     ({@link acquireLeaseMemoryCleanupCredentials}, used by lease-termination
 *     cleanup).
 */

import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { z } from "zod";

import { leaseMemoryNamespace } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/sandbox-agent.types.js";

export interface AcquireHistoryMemoryCredentialsProps {
  stsClient: STSClient;
  memoryAccessRoleArn: string;
  memoryResourceArn: string;
  /** AgentCore Memory actor id (the caller's IDC user id) */
  actorId: string;
  memorySessionId: string;
}

export interface ScopedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export async function acquireHistoryMemoryCredentials(
  props: AcquireHistoryMemoryCredentialsProps,
): Promise<ScopedCredentials | null> {
  const {
    stsClient,
    memoryAccessRoleArn,
    memoryResourceArn,
    actorId,
    memorySessionId,
  } = props;

  const sessionPolicy = JSON.stringify(
    buildSessionPolicy(memoryResourceArn, actorId, memorySessionId),
  );

  return assumeWithSessionPolicy({
    stsClient,
    memoryAccessRoleArn,
    sessionName: `agent-memory-${actorId.slice(0, 28)}`,
    sessionPolicy,
  });
}

export interface AcquireLeaseCleanupCredentialsProps {
  stsClient: STSClient;
  memoryAccessRoleArn: string;
  memoryResourceArn: string;
  leaseId: string;
}

/**
 * Credentials for lease-termination LTM cleanup: list and delete every actor's
 * memory records under one lease, and nothing else.
 */
export async function acquireLeaseMemoryCleanupCredentials(
  props: AcquireLeaseCleanupCredentialsProps,
): Promise<ScopedCredentials | null> {
  const {
    stsClient,
    memoryAccessRoleArn,
    memoryResourceArn,
    leaseId: rawLeaseId,
  } = props;
  const leaseId = z.uuid().parse(rawLeaseId);

  return assumeWithSessionPolicy({
    stsClient,
    memoryAccessRoleArn,
    sessionName: `agent-cleanup-${leaseId}`,
    sessionPolicy: JSON.stringify(
      buildLeaseCleanupSessionPolicy(
        memoryResourceArn,
        leaseMemoryNamespace(leaseId),
      ),
    ),
  });
}

async function assumeWithSessionPolicy(props: {
  stsClient: STSClient;
  memoryAccessRoleArn: string;
  sessionName: string;
  sessionPolicy: string;
}): Promise<ScopedCredentials | null> {
  const result = await props.stsClient.send(
    new AssumeRoleCommand({
      RoleArn: props.memoryAccessRoleArn,
      RoleSessionName: props.sessionName,
      Policy: props.sessionPolicy,
      DurationSeconds: 900,
    }),
  );

  if (
    !result?.Credentials?.AccessKeyId ||
    !result.Credentials.SecretAccessKey ||
    !result.Credentials.SessionToken
  ) {
    return null;
  }

  return {
    accessKeyId: result.Credentials.AccessKeyId,
    secretAccessKey: result.Credentials.SecretAccessKey,
    sessionToken: result.Credentials.SessionToken,
  };
}

/**
 * Lease-wide LTM cleanup policy.
 */
function buildLeaseCleanupSessionPolicy(
  memoryResourceArn: string,
  leaseNamespace: string,
): { Version: string; Statement: unknown[] } {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["bedrock-agentcore:ListMemoryRecords"],
        Resource: memoryResourceArn,
        Condition: {
          StringLike: {
            "bedrock-agentcore:namespacePath": `${leaseNamespace}*`,
          },
        },
      },
      {
        Effect: "Allow",
        Action: ["bedrock-agentcore:BatchDeleteMemoryRecords"],
        Resource: memoryResourceArn,
        Condition: {
          StringLike: {
            "bedrock-agentcore:namespace": `${leaseNamespace}*`,
          },
        },
      },
      {
        Effect: "Allow",
        Action: ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"],
        Resource: "*",
      },
    ],
  };
}

/**
 * Read-only STM access to one actor's events in one session (the history API's
 * only call). No LTM: nothing reads LTM through these credentials, and
 * lease-termination cleanup uses {@link acquireLeaseMemoryCleanupCredentials}.
 */
function buildSessionPolicy(
  memoryResourceArn: string,
  actorId: string,
  memorySessionId: string,
): { Version: string; Statement: unknown[] } {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["bedrock-agentcore:ListEvents"],
        Resource: memoryResourceArn,
        Condition: {
          StringEquals: {
            "bedrock-agentcore:actorId": actorId,
            "bedrock-agentcore:sessionId": memorySessionId,
          },
        },
      },
      {
        Effect: "Allow",
        Action: ["kms:GenerateDataKey", "kms:Decrypt"],
        Resource: "*",
      },
    ],
  };
}
