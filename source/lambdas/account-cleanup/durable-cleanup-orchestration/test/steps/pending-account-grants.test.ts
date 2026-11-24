// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DescribeAccountAssignmentCreationStatusCommand,
  ListAccountAssignmentCreationStatusCommand,
  SSOAdminClient,
} from "@aws-sdk/client-sso-admin";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hasPendingAccountGrants } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/pending-account-grants.js";
import type { CleanupContext } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/types.js";

const send = vi.fn();
const INSTANCE_ARN = "arn:aws:sso:::instance/ssoins-1234567890abcdef0";
const ACCOUNT_ID = "123456789012";
const context = { accountId: ACCOUNT_ID, env: {} } as CleanupContext;

vi.mock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
  IsbServices: {
    idcStackConfigStore: () => ({
      get: async () => ({ ssoInstanceArn: INSTANCE_ARN }),
    }),
  },
}));
vi.mock("@amzn/innovation-sandbox-commons/sdk-clients/index.js", () => ({
  IsbClients: {
    ssoAdmin: () =>
      Object.assign(new SSOAdminClient({ region: "us-east-1" }), { send }),
  },
}));
vi.mock(
  "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
  () => ({
    fromTemporaryIsbIdcCredentials: () => ({}),
  }),
);
vi.mock("p-throttle", () => ({
  default: () => (fn: unknown) => fn,
}));

function creation(Status: string, TargetId = ACCOUNT_ID) {
  return {
    AccountAssignmentCreationStatus: {
      Status,
      TargetId,
      TargetType: "AWS_ACCOUNT",
    },
  };
}

describe("hasPendingAccountGrants", () => {
  beforeEach(() => send.mockReset());

  it("follows pagination and finds this account after an unrelated pending grant", async () => {
    send
      .mockResolvedValueOnce({
        AccountAssignmentsCreationStatus: [{ RequestId: "other-account" }],
        NextToken: "page-2",
      })
      .mockResolvedValueOnce(creation("IN_PROGRESS", "999999999999"))
      .mockResolvedValueOnce({
        AccountAssignmentsCreationStatus: [{ RequestId: "this-account" }],
      })
      .mockResolvedValueOnce(creation("IN_PROGRESS"));

    expect(await hasPendingAccountGrants(context)).toBe(true);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(
      ListAccountAssignmentCreationStatusCommand,
    );
    expect(send.mock.calls[0]![0].input).toMatchObject({
      InstanceArn: INSTANCE_ARN,
      Filter: { Status: "IN_PROGRESS" },
    });
    expect(send.mock.calls[2]![0].input.NextToken).toBe("page-2");
    expect(send.mock.calls[3]![0]).toBeInstanceOf(
      DescribeAccountAssignmentCreationStatusCommand,
    );
    expect(
      send.mock.calls[3]![0].input.AccountAssignmentCreationRequestId,
    ).toBe("this-account");
  });

  it("does not wait for pending grants on other accounts", async () => {
    send
      .mockResolvedValueOnce({
        AccountAssignmentsCreationStatus: [{ RequestId: "other" }],
      })
      .mockResolvedValueOnce(creation("IN_PROGRESS", "999999999999"));
    expect(await hasPendingAccountGrants(context)).toBe(false);
  });

  it.each(["SUCCEEDED", "FAILED"])(
    "accepts a request that becomes %s between list and describe",
    async (status) => {
      send
        .mockResolvedValueOnce({
          AccountAssignmentsCreationStatus: [{ RequestId: "completed" }],
        })
        .mockResolvedValueOnce(creation(status));
      expect(await hasPendingAccountGrants(context)).toBe(false);
    },
  );

  it("accepts an empty pending-request list", async () => {
    send.mockResolvedValueOnce({ AccountAssignmentsCreationStatus: [] });
    expect(await hasPendingAccountGrants(context)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["list", "describe"])(
    "propagates %s failures instead of declaring the account clear",
    async (operation) => {
      if (operation === "describe") {
        send.mockResolvedValueOnce({
          AccountAssignmentsCreationStatus: [{ RequestId: "unknown" }],
        });
      }
      send.mockRejectedValueOnce(new Error("IDC unavailable"));
      await expect(hasPendingAccountGrants(context)).rejects.toThrow(
        "IDC unavailable",
      );
    },
  );

  it("rejects an entry without a request ID", async () => {
    send.mockResolvedValueOnce({ AccountAssignmentsCreationStatus: [{}] });
    await expect(hasPendingAccountGrants(context)).rejects.toThrow(
      "request ID",
    );
  });

  it.each([
    {},
    { AccountAssignmentCreationStatus: { Status: "IN_PROGRESS" } },
    creation("UNKNOWN"),
  ])("fails closed when a creation cannot be classified", async (response) => {
    send
      .mockResolvedValueOnce({
        AccountAssignmentsCreationStatus: [{ RequestId: "unknown" }],
      })
      .mockResolvedValueOnce(response);
    await expect(hasPendingAccountGrants(context)).rejects.toThrow();
  });
});
