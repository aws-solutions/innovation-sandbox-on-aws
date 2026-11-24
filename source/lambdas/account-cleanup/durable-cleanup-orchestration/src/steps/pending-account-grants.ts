// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  DescribeAccountAssignmentCreationStatusCommand,
  paginateListAccountAssignmentCreationStatus,
  StatusValues,
  TargetType,
} from "@aws-sdk/client-sso-admin";
import pThrottle from "p-throttle";

import type { CleanupContext } from "./types.js";

// List and describe share one request per second per Lambda environment.
// IDC caps outstanding asynchronous CreateAccountAssignment requests at 15,
// keeping a typical pending-grant scan small even at this conservative rate.
// https://docs.aws.amazon.com/singlesignon/latest/userguide/limits.html
const throttleStatusRead = pThrottle({ limit: 1, interval: 1000 });
const waitForPageRead = throttleStatusRead(() => Promise.resolve());

export async function hasPendingAccountGrants(
  ctx: CleanupContext,
): Promise<boolean> {
  const { accountId, env } = ctx;
  const credentials = fromTemporaryIsbIdcCredentials(env);
  const client = IsbClients.ssoAdmin(env, credentials);
  const { ssoInstanceArn } = await IsbServices.idcStackConfigStore(env).get();
  const paginator = paginateListAccountAssignmentCreationStatus(
    { client, pageSize: 100 },
    {
      InstanceArn: ssoInstanceArn,
      Filter: { Status: StatusValues.IN_PROGRESS },
    },
  );
  const describe = throttleStatusRead((requestId: string) =>
    client.send(
      new DescribeAccountAssignmentCreationStatusCommand({
        InstanceArn: ssoInstanceArn,
        AccountAssignmentCreationRequestId: requestId,
      }),
    ),
  );

  // Gate the first fetch and each subsequent fetch through the shared throttle.
  await waitForPageRead();
  for await (const page of paginator) {
    for (const request of page.AccountAssignmentsCreationStatus ?? []) {
      if (!request.RequestId) {
        throw new Error("IDC creation status did not include a request ID");
      }
      const response = await describe(request.RequestId);
      const status = response.AccountAssignmentCreationStatus;
      if (!status?.TargetId || status.TargetType !== TargetType.AWS_ACCOUNT) {
        throw new Error(
          `Unable to identify account for IDC creation ${request.RequestId}`,
        );
      }
      if (status.TargetId !== accountId) {
        continue;
      }
      switch (status.Status) {
        case StatusValues.IN_PROGRESS:
          return true;
        case StatusValues.SUCCEEDED:
        case StatusValues.FAILED:
          // A request can complete between List and Describe. The subsequent
          // assignment sweep must run after this check to remove its result.
          break;
        default:
          throw new Error(
            `Unknown IDC creation status for request ${request.RequestId}`,
          );
      }
    }
    await waitForPageRead();
  }

  return false;
}
