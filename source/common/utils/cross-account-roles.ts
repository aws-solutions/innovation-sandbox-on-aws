// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";

const ASSUME_ROLE_DURATION_SECONDS = 15 * 60; // min allowed is 900s (15m)

export function fromTemporaryIsbSpokeCredentials({
  intermediateRoleArn,
  targetRoleArn,
  sessionName,
  customUserAgent,
}: {
  intermediateRoleArn: string;
  targetRoleArn: string;
  sessionName: string;
  customUserAgent: string;
}) {
  return fromTemporaryCredentials({
    params: {
      RoleArn: targetRoleArn,
      RoleSessionName: sessionName,
      DurationSeconds: ASSUME_ROLE_DURATION_SECONDS,
    },
    masterCredentials: fromTemporaryCredentials({
      params: {
        RoleArn: intermediateRoleArn,
        RoleSessionName: "IsbIntermediateRoleSession",
        DurationSeconds: ASSUME_ROLE_DURATION_SECONDS,
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
