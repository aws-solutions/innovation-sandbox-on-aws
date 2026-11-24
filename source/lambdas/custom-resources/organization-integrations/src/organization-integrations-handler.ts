// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import {
  ActivateOrganizationsAccessCommand,
  CloudFormationClient,
  DescribeOrganizationsAccessCommand,
} from "@aws-sdk/client-cloudformation";
import { GetRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import {
  OrganizationsClient,
  paginateListAWSServiceAccessForOrganization,
} from "@aws-sdk/client-organizations";
import {
  EnableSharingWithAwsOrganizationCommand,
  RAMClient,
} from "@aws-sdk/client-ram";
import type {
  CdkCustomResourceEvent,
  CdkCustomResourceResponse,
  Context,
} from "aws-lambda";
import { backOff } from "exponential-backoff";

import { customResourceCalls } from "@amzn/innovation-sandbox-commons/lambda/custom-resource-calls.js";
import {
  BaseLambdaEnvironment,
  BaseLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";

type IntegrationsContext = Context &
  ValidatedEnvironment<BaseLambdaEnvironment>;
type Outcome = "already-active" | "activated";
type RamClients = { orgs: OrganizationsClient; iam: IAMClient; ram: RAMClient };

// Fixed so CloudFormation never replaces the resource; there is nothing to replace.
const PHYSICAL_RESOURCE_ID = "IsbOrganizationIntegrations";
const RAM_SERVICE_PRINCIPAL = "ram.amazonaws.com";
const RAM_SERVICE_LINKED_ROLE = "AWSServiceRoleForResourceAccessManager";
const MANAGEMENT_ACCOUNT_HINT =
  "; the AccountPool stack must be deployed in the organization management account";
const ALL_FEATURES_HINT =
  "; the organization must have all features enabled in AWS Organizations";
/**
 * Remediation appended to the CloudFormation reason, keyed by SDK error name.
 * CloudFormation is a Query API, so an unmodeled error carries its raw code as
 * the name: a call from outside the management account is a ValidationError
 * there, an AccessDeniedException from Organizations and an
 * OperationNotPermittedException from RAM.
 */
const HINTS: Partial<Record<string, string>> = {
  ValidationError: MANAGEMENT_ACCOUNT_HINT,
  AccessDeniedException: MANAGEMENT_ACCOUNT_HINT,
  InvalidOperationException: ALL_FEATURES_HINT,
  OperationNotPermittedException: MANAGEMENT_ACCOUNT_HINT + ALL_FEATURES_HINT,
};
// A just-enabled integration can read as inactive for a few seconds, since IAM
// and Organizations are eventually consistent, and CloudFormation does not
// retry a failed custom resource. A confirming read is retried for up to 15
// seconds, so both confirmations fit within the function's one-minute timeout.
const CONFIRM_ATTEMPTS = 5;
const CONFIRM_FIRST_DELAY_MS = 1_000;

const tracer = new Tracer();
const logger = new Logger();
const { calling, wrap } = customResourceCalls(logger, HINTS);

const lambdaHandler = async (
  event: CdkCustomResourceEvent,
  context: IntegrationsContext,
): Promise<CdkCustomResourceResponse> => {
  logger.info({
    message: "Organization integrations custom resource invoked",
    requestType: event.RequestType,
    logicalResourceId: event.LogicalResourceId,
  });
  switch (event.RequestType) {
    case "Create":
    case "Update": {
      const stackSetsTrustedAccess = await ensureStackSetsTrustedAccess(
        IsbClients.cloudFormation(context.env),
      );
      const ramSharing = await ensureRamSharing({
        orgs: IsbClients.orgs(context.env),
        iam: IsbClients.iam(context.env),
        ram: IsbClients.ram(context.env),
      });
      return {
        Data: { stackSetsTrustedAccess, ramSharing },
        PhysicalResourceId: PHYSICAL_RESOURCE_ID,
      };
    }
    case "Delete": {
      // Turning either integration off would break every service-managed
      // StackSet and every organization resource share, not only this
      // solution's, and StackSets would first need its delegated
      // administrators deregistered.
      logger.info(
        "Leaving StackSets trusted access and RAM sharing with Organizations active on delete",
      );
      return { PhysicalResourceId: event.PhysicalResourceId };
    }
  }
};

async function ensureStackSetsTrustedAccess(
  cfnClient: CloudFormationClient,
): Promise<Outcome> {
  const status = await describeStackSetsStatus(cfnClient);
  if (status === "ENABLED") {
    logger.info(
      "StackSets trusted access with Organizations is already active; nothing to do",
    );
    return "already-active";
  }
  if (status === "DISABLED_PERMANENTLY") {
    throw new Error(
      "StackSets trusted access with Organizations is permanently disabled for this organization; re-enable it from the CloudFormation console in the management account before deploying",
    );
  }
  logger.info({
    message: "Activating StackSets trusted access with Organizations",
    status,
  });
  await calling("ActivateOrganizationsAccess", () =>
    cfnClient.send(new ActivateOrganizationsAccessCommand({})),
  );
  let activated: string | undefined;
  const confirmed = await confirm(async () => {
    activated = await describeStackSetsStatus(cfnClient);
    return activated === "ENABLED";
  });
  if (!confirmed) {
    throw new Error(
      `StackSets trusted access with Organizations still reports ${activated} after activation; redeploy once DescribeOrganizationsAccess reports ENABLED`,
    );
  }
  logger.info("StackSets trusted access with Organizations is now active");
  return "activated";
}

async function describeStackSetsStatus(
  cfnClient: CloudFormationClient,
): Promise<string | undefined> {
  const { Status } = await calling("DescribeOrganizationsAccess", () =>
    cfnClient.send(new DescribeOrganizationsAccessCommand({})),
  );
  return Status;
}

async function ensureRamSharing(clients: RamClients): Promise<Outcome> {
  if (await ramSharingActive(clients)) {
    logger.info(
      "RAM sharing with Organizations is already active; nothing to do",
    );
    return "already-active";
  }
  logger.info("Enabling RAM sharing with Organizations");
  const { returnValue } = await calling(
    "EnableSharingWithAwsOrganization",
    () => clients.ram.send(new EnableSharingWithAwsOrganizationCommand({})),
  );
  if (
    returnValue !== true ||
    !(await confirm(() => ramSharingActive(clients)))
  ) {
    throw new Error(
      "RAM sharing with Organizations is still not active after enabling it; redeploy once the RAM console shows sharing with AWS Organizations enabled",
    );
  }
  logger.info("RAM sharing with Organizations is now active");
  return "activated";
}

/**
 * Enabling the RAM principal through Organizations alone creates no
 * service-linked role, and sharing then fails, so both halves are checked.
 */
async function ramSharingActive(clients: RamClients): Promise<boolean> {
  const listed = await calling(
    "ListAWSServiceAccessForOrganization",
    async () => {
      for await (const page of paginateListAWSServiceAccessForOrganization(
        { client: clients.orgs },
        {},
      )) {
        if (
          page.EnabledServicePrincipals?.some(
            (p) => p.ServicePrincipal === RAM_SERVICE_PRINCIPAL,
          )
        ) {
          return true;
        }
      }
      return false;
    },
  );
  if (!listed) {
    return false;
  }
  try {
    await clients.iam.send(
      new GetRoleCommand({ RoleName: RAM_SERVICE_LINKED_ROLE }),
    );
    return true;
  } catch (error) {
    if ((error as Error).name === "NoSuchEntityException") {
      return false;
    }
    throw wrap("GetRole", error);
  }
}

class NotYetActive extends Error {}

/**
 * Re-reads a just-enabled integration until `check` reports it active, false
 * once the attempts run out. A read that fails outright is not retried.
 */
async function confirm(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await backOff(
      async () => {
        if (!(await check())) {
          throw new NotYetActive();
        }
        return true;
      },
      {
        numOfAttempts: CONFIRM_ATTEMPTS,
        startingDelay: CONFIRM_FIRST_DELAY_MS,
        retry: (error) => error instanceof NotYetActive,
      },
    );
  } catch (error) {
    if (error instanceof NotYetActive) {
      return false;
    }
    throw error;
  }
}

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: BaseLambdaEnvironmentSchema,
  moduleName: "organization-integrations",
}).handler(lambdaHandler);
