// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  ActivateOrganizationsAccessCommand,
  CloudFormationClient,
  DescribeOrganizationsAccessCommand,
} from "@aws-sdk/client-cloudformation";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import {
  ListAWSServiceAccessForOrganizationCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import {
  EnableSharingWithAwsOrganizationCommand,
  RAMClient,
} from "@aws-sdk/client-ram";
import type { CdkCustomResourceEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { handler } from "@amzn/innovation-sandbox-organization-integrations/organization-integrations-handler.js";

const cfnMock = mockClient(CloudFormationClient);
const orgsMock = mockClient(OrganizationsClient);
const iamMock = mockClient(IAMClient);
const ramMock = mockClient(RAMClient);
const testEnv = generateSchemaData(BaseLambdaEnvironmentSchema);

const PHYSICAL_ID = "IsbOrganizationIntegrations";
const MANAGEMENT_ACCOUNT_HINT =
  "; the AccountPool stack must be deployed in the organization management account";
const ALL_FEATURES_HINT =
  "; the organization must have all features enabled in AWS Organizations";
const RAM_ENABLED = {
  EnabledServicePrincipals: [{ ServicePrincipal: "ram.amazonaws.com" }],
};
const RAM_NOT_ENABLED = {
  EnabledServicePrincipals: [{ ServicePrincipal: "sso.amazonaws.com" }],
};
const bothActive = {
  Data: {
    stackSetsTrustedAccess: "already-active",
    ramSharing: "already-active",
  },
  PhysicalResourceId: PHYSICAL_ID,
};

function createEvent(
  requestType: "Create" | "Update" | "Delete" = "Create",
): CdkCustomResourceEvent {
  return {
    RequestType: requestType,
    ServiceToken: "service-token",
    ResponseURL: "https://example.com/response",
    StackId: "arn:aws:cloudformation:us-east-1:111111111111:stack/test/uuid",
    RequestId: "request-id",
    LogicalResourceId: "TestResource",
    ResourceType: "Custom::OrganizationIntegrations",
    PhysicalResourceId: requestType === "Create" ? undefined : PHYSICAL_ID,
    ResourceProperties: { ServiceToken: "service-token" },
  } as CdkCustomResourceEvent;
}

function awsError(name: string, message = name) {
  return Object.assign(new Error(message), { name });
}

const invoke = () => handler(createEvent(), mockContext(testEnv));

// The confirming reads back off for up to 15 seconds; fake timers let a test
// run through every retry without waiting.
async function invokeThroughRetries() {
  vi.useFakeTimers();
  const result = invoke();
  // attach before advancing so a rejection is never unhandled
  const settled = result.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(20_000);
  const outcome = await settled;
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

beforeEach(() => {
  bulkStubEnv(testEnv);
  for (const mock of [cfnMock, orgsMock, iamMock, ramMock]) {
    mock.reset();
  }
  // everything already on unless a test says otherwise
  cfnMock
    .on(DescribeOrganizationsAccessCommand)
    .resolves({ Status: "ENABLED" });
  cfnMock.on(ActivateOrganizationsAccessCommand).resolves({});
  orgsMock.on(ListAWSServiceAccessForOrganizationCommand).resolves(RAM_ENABLED);
  iamMock.on(GetRoleCommand).resolves({});
  ramMock
    .on(EnableSharingWithAwsOrganizationCommand)
    .resolves({ returnValue: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("StackSets trusted access", () => {
  it.each(["Create", "Update"] as const)(
    "leaves active integrations alone on %s",
    async (requestType) => {
      const result = await handler(
        createEvent(requestType),
        mockContext(testEnv),
      );

      expect(result).toEqual(bothActive);
      expect(cfnMock.commandCalls(ActivateOrganizationsAccessCommand)).toEqual(
        [],
      );
      expect(
        ramMock.commandCalls(EnableSharingWithAwsOrganizationCommand),
      ).toEqual([]);
    },
  );

  it("activates trusted access when it is disabled and confirms it took", async () => {
    cfnMock
      .on(DescribeOrganizationsAccessCommand)
      .resolvesOnce({ Status: "DISABLED" })
      .resolvesOnce({ Status: "ENABLED" });

    const result = await invoke();

    expect(result.Data).toEqual({
      stackSetsTrustedAccess: "activated",
      ramSharing: "already-active",
    });
    expect(
      cfnMock.commandCalls(ActivateOrganizationsAccessCommand),
    ).toHaveLength(1);
    expect(
      cfnMock.commandCalls(DescribeOrganizationsAccessCommand),
    ).toHaveLength(2);
  });

  it("fails without activating when trusted access is permanently disabled", async () => {
    cfnMock
      .on(DescribeOrganizationsAccessCommand)
      .resolves({ Status: "DISABLED_PERMANENTLY" });

    await expect(invoke()).rejects.toThrow(
      "StackSets trusted access with Organizations is permanently disabled for this organization; re-enable it from the CloudFormation console in the management account before deploying",
    );
    expect(cfnMock.commandCalls(ActivateOrganizationsAccessCommand)).toEqual(
      [],
    );
    expect(orgsMock.calls()).toEqual([]);
  });

  it.each([
    ["InvalidOperationException", ALL_FEATURES_HINT],
    ["ValidationError", MANAGEMENT_ACCOUNT_HINT],
    ["AccessDenied", ""],
  ])(
    "names the failed call and the remedy when activation fails with %s",
    async (errorName, hint) => {
      cfnMock
        .on(DescribeOrganizationsAccessCommand)
        .resolves({ Status: "DISABLED" });
      cfnMock
        .on(ActivateOrganizationsAccessCommand)
        .rejects(awsError(errorName, "rejected"));

      // an Error matches on the whole message, so the no-hint row can fail
      await expect(invoke()).rejects.toThrow(
        new Error(
          `ActivateOrganizationsAccess failed: ${errorName}: rejected${hint}`,
        ),
      );
    },
  );

  it("confirms trusted access that reads ENABLED only after a few seconds", async () => {
    cfnMock
      .on(DescribeOrganizationsAccessCommand)
      .resolvesOnce({ Status: "DISABLED" })
      .resolvesOnce({ Status: "DISABLED" })
      .resolvesOnce({ Status: "DISABLED" })
      .resolves({ Status: "ENABLED" });

    const result = await invokeThroughRetries();

    expect(result.Data?.stackSetsTrustedAccess).toBe("activated");
    expect(
      cfnMock.commandCalls(ActivateOrganizationsAccessCommand),
    ).toHaveLength(1);
    // the first read decides to activate; three confirming reads follow it
    expect(
      cfnMock.commandCalls(DescribeOrganizationsAccessCommand),
    ).toHaveLength(4);
  });

  it("fails when the status still does not read ENABLED once the retries run out", async () => {
    cfnMock
      .on(DescribeOrganizationsAccessCommand)
      .resolves({ Status: "DISABLED" });

    await expect(invokeThroughRetries()).rejects.toThrow(
      "StackSets trusted access with Organizations still reports DISABLED after activation; redeploy once DescribeOrganizationsAccess reports ENABLED",
    );
    // one read before activating, then five confirming attempts
    expect(
      cfnMock.commandCalls(DescribeOrganizationsAccessCommand),
    ).toHaveLength(6);
  });

  it("does not retry a confirming read that fails outright", async () => {
    cfnMock
      .on(DescribeOrganizationsAccessCommand)
      .resolvesOnce({ Status: "DISABLED" })
      .rejects(awsError("AccessDenied", "denied"));

    await expect(invokeThroughRetries()).rejects.toThrow(
      new Error("DescribeOrganizationsAccess failed: AccessDenied: denied"),
    );
    expect(
      cfnMock.commandCalls(DescribeOrganizationsAccessCommand),
    ).toHaveLength(2);
  });

  it("names the failed call when the status cannot be read", async () => {
    cfnMock
      .on(DescribeOrganizationsAccessCommand)
      .rejects(
        awsError("ValidationError", "You must be the management account"),
      );

    await expect(invoke()).rejects.toThrow(
      `DescribeOrganizationsAccess failed: ValidationError: You must be the management account${MANAGEMENT_ACCOUNT_HINT}`,
    );
  });
});

describe("RAM sharing with Organizations", () => {
  it("enables sharing when the RAM principal is not enabled and confirms it took", async () => {
    orgsMock
      .on(ListAWSServiceAccessForOrganizationCommand)
      .resolvesOnce(RAM_NOT_ENABLED)
      .resolvesOnce(RAM_ENABLED);

    const result = await invoke();

    expect(result.Data).toEqual({
      stackSetsTrustedAccess: "already-active",
      ramSharing: "activated",
    });
    expect(
      ramMock.commandCalls(EnableSharingWithAwsOrganizationCommand),
    ).toHaveLength(1);
  });

  it("enables sharing when the principal is enabled but the service-linked role is missing", async () => {
    iamMock
      .on(GetRoleCommand)
      .rejectsOnce(awsError("NoSuchEntityException", "no such role"))
      .resolvesOnce({});

    const result = await invoke();

    expect(result.Data?.ramSharing).toBe("activated");
    expect(
      ramMock.commandCalls(EnableSharingWithAwsOrganizationCommand),
    ).toHaveLength(1);
    expect(iamMock.commandCalls(GetRoleCommand)[0]!.args[0].input).toEqual({
      RoleName: "AWSServiceRoleForResourceAccessManager",
    });
  });

  it("finds the RAM principal on a later page", async () => {
    orgsMock
      .on(ListAWSServiceAccessForOrganizationCommand)
      .resolves({ ...RAM_NOT_ENABLED, NextToken: "page-2" })
      .on(ListAWSServiceAccessForOrganizationCommand, { NextToken: "page-2" })
      .resolves(RAM_ENABLED);

    const result = await invoke();

    expect(result).toEqual(bothActive);
    expect(
      orgsMock.commandCalls(ListAWSServiceAccessForOrganizationCommand),
    ).toHaveLength(2);
  });

  it("confirms sharing whose service-linked role appears only after a few seconds", async () => {
    iamMock
      .on(GetRoleCommand)
      .rejectsOnce(awsError("NoSuchEntityException", "no such role"))
      .rejectsOnce(awsError("NoSuchEntityException", "no such role"))
      .rejectsOnce(awsError("NoSuchEntityException", "no such role"))
      .resolves({});

    const result = await invokeThroughRetries();

    expect(result.Data?.ramSharing).toBe("activated");
    expect(
      ramMock.commandCalls(EnableSharingWithAwsOrganizationCommand),
    ).toHaveLength(1);
    // the first check decides to enable; three confirming checks follow it
    expect(iamMock.commandCalls(GetRoleCommand)).toHaveLength(4);
  });

  it("fails when sharing still is not active once the retries run out", async () => {
    orgsMock
      .on(ListAWSServiceAccessForOrganizationCommand)
      .resolves(RAM_NOT_ENABLED);

    await expect(invokeThroughRetries()).rejects.toThrow(
      "RAM sharing with Organizations is still not active after enabling it; redeploy once the RAM console shows sharing with AWS Organizations enabled",
    );
    // one check before enabling, then five confirming attempts
    expect(
      orgsMock.commandCalls(ListAWSServiceAccessForOrganizationCommand),
    ).toHaveLength(6);
  });

  it("does not retry a confirming check that fails outright", async () => {
    iamMock
      .on(GetRoleCommand)
      .rejectsOnce(awsError("NoSuchEntityException", "no such role"))
      .rejects(awsError("AccessDenied", "denied"));

    await expect(invokeThroughRetries()).rejects.toThrow(
      new Error("GetRole failed: AccessDenied: denied"),
    );
    expect(iamMock.commandCalls(GetRoleCommand)).toHaveLength(2);
  });

  it("fails when RAM reports the enable request did not succeed", async () => {
    orgsMock
      .on(ListAWSServiceAccessForOrganizationCommand)
      .resolvesOnce(RAM_NOT_ENABLED)
      .resolvesOnce(RAM_ENABLED);
    ramMock
      .on(EnableSharingWithAwsOrganizationCommand)
      .resolves({ returnValue: false });

    await expect(invoke()).rejects.toThrow(
      "RAM sharing with Organizations is still not active after enabling it",
    );
  });

  it("names the failed call and the remedy when RAM refuses", async () => {
    orgsMock
      .on(ListAWSServiceAccessForOrganizationCommand)
      .resolves(RAM_NOT_ENABLED);
    ramMock
      .on(EnableSharingWithAwsOrganizationCommand)
      .rejects(awsError("OperationNotPermittedException", "not permitted"));

    await expect(invoke()).rejects.toThrow(
      new Error(
        `EnableSharingWithAwsOrganization failed: OperationNotPermittedException: not permitted${MANAGEMENT_ACCOUNT_HINT}${ALL_FEATURES_HINT}`,
      ),
    );
  });

  it("names the failed call and the remedy when Organizations refuses the listing", async () => {
    orgsMock
      .on(ListAWSServiceAccessForOrganizationCommand)
      .rejects(awsError("AccessDeniedException", "not the management account"));

    await expect(invoke()).rejects.toThrow(
      `ListAWSServiceAccessForOrganization failed: AccessDeniedException: not the management account${MANAGEMENT_ACCOUNT_HINT}`,
    );
    expect(
      ramMock.commandCalls(EnableSharingWithAwsOrganizationCommand),
    ).toEqual([]);
  });

  it("does not treat an unreadable service-linked role as missing", async () => {
    iamMock.on(GetRoleCommand).rejects(awsError("AccessDenied", "denied"));

    await expect(invoke()).rejects.toThrow(
      new Error("GetRole failed: AccessDenied: denied"),
    );
    expect(
      ramMock.commandCalls(EnableSharingWithAwsOrganizationCommand),
    ).toEqual([]);
  });
});

it("does nothing on delete and keeps the physical id", async () => {
  const result = await handler(createEvent("Delete"), mockContext(testEnv));

  expect(result).toEqual({ PhysicalResourceId: PHYSICAL_ID });
  for (const mock of [cfnMock, orgsMock, iamMock, ramMock]) {
    expect(mock.calls()).toEqual([]);
  }
});
