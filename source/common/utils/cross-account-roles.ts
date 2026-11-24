// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import {
  build as buildArn,
  validate as isArn,
  parse as parseArn,
} from "@aws-sdk/util-arn-parser";

const ASSUME_ROLE_DURATION_SECONDS = 15 * 60; // min allowed is 900s (15m)

/**
 * AWS partition segment of an ARN (`aws`, `aws-us-gov`, `aws-cn`). Throws if
 * malformed — pass `onInvalid` to throw a domain-specific error instead.
 */
export function parsePartitionFromArn(
  arn: string,
  onInvalid?: () => Error,
): string {
  // isArn gates parseArn so a malformed ARN never throws here; the empty-string
  // guard also rejects a structurally-valid ARN with an absent partition.
  const partition = isArn(arn) ? parseArn(arn).partition : undefined;
  if (!partition) {
    throw (
      onInvalid?.() ?? new Error(`Cannot derive AWS partition from ARN: ${arn}`)
    );
  }
  return partition;
}

/**
 * ARN of SandboxAgentRole-{ns} in a sandbox account. Single source of truth
 * for the shape, shared by the CLI tool and inference assume-role calls.
 */
export function sandboxAgentRoleArn(
  partition: string,
  accountId: string,
  roleName: string,
): string {
  return buildArn({
    partition,
    service: "iam",
    region: "",
    accountId,
    resource: `role/${roleName}`,
  });
}

export function fromTemporaryIsbSpokeCredentials({
  intermediateRoleArn,
  targetRoleArn,
  sessionName,
  customUserAgent,
  sourceIdentity,
  sessionPolicy,
  policyArns,
  intermediateSessionName,
}: {
  intermediateRoleArn: string;
  targetRoleArn: string;
  sessionName: string;
  customUserAgent: string;
  /**
   * Sets `sts:SourceIdentity` on the FIRST hop only (the intermediate role).
   * SourceIdentity is immutable and propagates automatically to later hops —
   * setting it again on hop 2 fails with `InvalidParameter`. Surfaces in
   * CloudTrail as `userIdentity.sessionContext.sourceIdentity`, giving
   * per-user attribution across the shared role chain.
   *
   * Requires `sts:SetSourceIdentity` on the intermediate role's trust and
   * permissions policies. Max 64 chars from `[\w+=,.@-]`.
   */
  sourceIdentity?: string;
  /**
   * Session policy attached to the FINAL hop, narrowing that session to the
   * intersection of the target role's permissions and this document.
   */
  sessionPolicy?: string;
  /**
   * Managed-policy ARNs attached to the FINAL hop's session. Each ARN is
   * separately intersected with the target role's permissions and the session
   * policy.
   */
  policyArns?: string[];
  /**
   * Overrides the hop-1 session name. Defaults to a shared constant, which
   * is fine for system flows; callers needing per-user CloudTrail
   * attribution on hop 1 should pass their own.
   */
  intermediateSessionName?: string;
}) {
  return fromTemporaryCredentials({
    params: {
      RoleArn: targetRoleArn,
      RoleSessionName: sessionName,
      DurationSeconds: ASSUME_ROLE_DURATION_SECONDS,
      // NOT SourceIdentity: it is set on hop 1 and propagates here.
      ...(sessionPolicy ? { Policy: sessionPolicy } : {}),
      ...(policyArns && policyArns.length > 0
        ? { PolicyArns: policyArns.map((arn) => ({ arn })) }
        : {}),
    },
    masterCredentials: fromTemporaryCredentials({
      params: {
        RoleArn: intermediateRoleArn,
        RoleSessionName:
          intermediateSessionName ?? "IsbIntermediateRoleSession",
        DurationSeconds: ASSUME_ROLE_DURATION_SECONDS,
        ...(sourceIdentity ? { SourceIdentity: sourceIdentity } : {}),
      },
      clientConfig: { customUserAgent },
    }),
    clientConfig: {
      customUserAgent,
    },
  });
}

export function fromTemporaryIsbOrgManagementCredentials(env: {
  INTERMEDIATE_ROLE_ARN: string;
  ORG_MGT_ROLE_ARN: string;
  USER_AGENT_EXTRA: string;
}) {
  return fromTemporaryIsbSpokeCredentials({
    intermediateRoleArn: env.INTERMEDIATE_ROLE_ARN,
    targetRoleArn: env.ORG_MGT_ROLE_ARN,
    sessionName: "IsbOrgMgtRoleSession",
    customUserAgent: env.USER_AGENT_EXTRA,
  });
}
export function fromTemporaryIsbIdcCredentials(env: {
  INTERMEDIATE_ROLE_ARN: string;
  IDC_ROLE_ARN: string;
  USER_AGENT_EXTRA: string;
}) {
  return fromTemporaryIsbSpokeCredentials({
    intermediateRoleArn: env.INTERMEDIATE_ROLE_ARN,
    targetRoleArn: env.IDC_ROLE_ARN,
    sessionName: "IsbIdcRoleSession",
    customUserAgent: env.USER_AGENT_EXTRA,
  });
}

export function fromTemporaryIsbSandboxAccountCredentials(
  sandboxAccountRoleArn: string,
  env: {
    INTERMEDIATE_ROLE_ARN: string;
    USER_AGENT_EXTRA: string;
  },
) {
  return fromTemporaryIsbSpokeCredentials({
    intermediateRoleArn: env.INTERMEDIATE_ROLE_ARN,
    targetRoleArn: sandboxAccountRoleArn,
    sessionName: "IsbSandboxAccountRoleSession",
    customUserAgent: env.USER_AGENT_EXTRA,
  });
}
