// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type {
  CdkCustomResourceEvent,
  CdkCustomResourceResponse,
  CloudFormationCustomResourceCreateEvent,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
  Context,
} from "aws-lambda";
import pThrottle from "p-throttle";

import { IdcConfig } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/idc-stack-config.js";
import {
  IdcConfigurerLambdaEnvironment,
  IdcConfigurerLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/idc-configurer-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import {
  CreateGroupCommand,
  GetGroupIdCommand,
  IdentitystoreClient,
  ResourceNotFoundException as IdentitystoreResourceNotFoundException,
} from "@aws-sdk/client-identitystore";
import {
  AttachManagedPolicyToPermissionSetCommand,
  CreatePermissionSetCommand,
  DescribePermissionSetCommand,
  paginateListPermissionSets,
  PermissionSet,
  SSOAdminClient,
  ConflictException as SSOAdminConflictException,
} from "@aws-sdk/client-sso-admin";

const tracer = new Tracer();
const logger = new Logger();

const GROUP_NAME_MAX_LENGTH = 128;
const PERMISSION_SET_NAME_MAX_LENGTH = 32;

// Throttle client commands (https://docs.aws.amazon.com/singlesignon/latest/userguide/limits.html#ssothrottlelimits)
const ssoAdminGlobalThrottle = pThrottle({
  limit: 10,
  interval: 1000,
});

const identitystoreGlobalThrottle = pThrottle({
  limit: 10,
  interval: 1000,
});

// Cache for permission sets to ensure we only fetch once if needed
let permissionSetsPromise: Promise<PermissionSet[]> | undefined;

export type IdcConfigurerResourceProperties = {
  namespace: string;
  ssoInstanceArn: string;
  identityStoreId: string;
  adminGroupName: string;
  managerGroupName: string;
  userGroupName: string;
  solutionVersion: string;
  supportedSchemas: string;
};

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: IdcConfigurerLambdaEnvironmentSchema,
  moduleName: "idc-configurer",
}).handler(lambdaHandler);

async function lambdaHandler(
  event: CdkCustomResourceEvent<IdcConfigurerResourceProperties>,
  context: Context & ValidatedEnvironment<IdcConfigurerLambdaEnvironment>,
): Promise<CdkCustomResourceResponse> {
  try {
    const identityStoreClient = IsbClients.identityStore(context.env);
    const ssoAdminClient = IsbClients.ssoAdmin(context.env);

    switch (event.RequestType) {
      case "Create":
      case "Update": {
        return onCreateOrUpdate(event, identityStoreClient, ssoAdminClient);
      }
      case "Delete": {
        return onDelete(event);
      }
    }
  } catch (error: any) {
    logger.error("Failed to handle IDC configuration request", error as Error);
    throw error;
  }
}

async function onCreateOrUpdate(
  event:
    | CloudFormationCustomResourceCreateEvent<IdcConfigurerResourceProperties>
    | CloudFormationCustomResourceUpdateEvent<IdcConfigurerResourceProperties>,
  identityStoreClient: IdentitystoreClient,
  ssoAdminClient: SSOAdminClient,
): Promise<CdkCustomResourceResponse> {
  const {
    namespace,
    ssoInstanceArn,
    identityStoreId,
    adminGroupName,
    managerGroupName,
    userGroupName,
    solutionVersion,
    supportedSchemas,
  }: IdcConfigurerResourceProperties = event.ResourceProperties;

  logger.info("Starting IDC resource creation/update", {
    requestType: event.RequestType,
    identityStoreId: identityStoreId,
    ssoInstanceArn: ssoInstanceArn,
  });

  const [groups, permissionSets] = await Promise.all([
    // Create groups
    Promise.all([
      createOrGetGroup(identityStoreClient, {
        name: adminGroupName,
        description:
          "Admin UserGroup for the Innovation Sandbox on AWS solution",
        identityStoreId,
      }),
      createOrGetGroup(identityStoreClient, {
        name: managerGroupName,
        description:
          "Manager UserGroup for the Innovation Sandbox on AWS solution",
        identityStoreId,
      }),
      createOrGetGroup(identityStoreClient, {
        name: userGroupName,
        description:
          "User UserGroup for the Innovation Sandbox on AWS solution",
        identityStoreId,
      }),
    ]),
    // Create permission sets
    Promise.all([
      createOrGetPermissionSet(ssoAdminClient, {
        name: `${namespace}_IsbAdminsPS`,
        description:
          "Admin PermissionSet for the Innovation Sandbox on AWS solution",
        ssoInstanceArn,
      }),
      createOrGetPermissionSet(ssoAdminClient, {
        name: `${namespace}_IsbManagersPS`,
        description:
          "Manager PermissionSet for the Innovation Sandbox on AWS solution",
        ssoInstanceArn,
      }),
      createOrGetPermissionSet(ssoAdminClient, {
        name: `${namespace}_IsbUsersPS`,
        description:
          "User PermissionSet for the Innovation Sandbox on AWS solution",
        ssoInstanceArn,
      }),
    ]),
  ]);

  const [adminGroup, managerGroup, userGroup] = groups;
  const [adminPS, managerPS, userPS] = permissionSets;

  const config: IdcConfig = {
    identityStoreId,
    ssoInstanceArn,
    adminGroupId: adminGroup.GroupId!,
    managerGroupId: managerGroup.GroupId!,
    userGroupId: userGroup.GroupId!,
    adminPermissionSetArn: adminPS.PermissionSet!.PermissionSetArn!,
    managerPermissionSetArn: managerPS.PermissionSet!.PermissionSetArn!,
    userPermissionSetArn: userPS.PermissionSet!.PermissionSetArn!,
    solutionVersion: solutionVersion,
    supportedSchemas: supportedSchemas,
  };

  logger.info("IDC resource creation/update completed", {
    adminGroupId: config.adminGroupId,
    managerGroupId: config.managerGroupId,
    userGroupId: config.userGroupId,
    adminPermissionSetArn: config.adminPermissionSetArn,
    managerPermissionSetArn: config.managerPermissionSetArn,
    userPermissionSetArn: config.userPermissionSetArn,
  });

  return {
    Data: config,
  };
}

async function onDelete(
  _event: CloudFormationCustomResourceDeleteEvent,
): Promise<CdkCustomResourceResponse> {
  logger.info("Retaining IDC groups and permission sets");
  return {
    Data: {
      status: "IDC groups and permission sets retained",
    },
  };
}

async function createOrGetGroup(
  client: IdentitystoreClient,
  params: {
    name: string;
    description: string;
    identityStoreId: string;
  },
) {
  const truncatedName = params.name.slice(0, GROUP_NAME_MAX_LENGTH);

  try {
    const existingGroup = await identitystoreGlobalThrottle(() =>
      client.send(
        new GetGroupIdCommand({
          IdentityStoreId: params.identityStoreId,
          AlternateIdentifier: {
            UniqueAttribute: {
              AttributePath: "DisplayName",
              AttributeValue: truncatedName,
            },
          },
        }),
      ),
    )();
    logger.info("Found existing group", {
      name: truncatedName,
      groupId: existingGroup.GroupId,
    });
    return existingGroup;
  } catch (error: any) {
    if (error instanceof IdentitystoreResourceNotFoundException) {
      const newGroup = await identitystoreGlobalThrottle(() =>
        client.send(
          new CreateGroupCommand({
            DisplayName: truncatedName,
            Description: params.description,
            IdentityStoreId: params.identityStoreId,
          }),
        ),
      )();

      logger.info("Successfully created new group", {
        name: truncatedName,
        groupId: newGroup.GroupId,
      });

      return newGroup;
    }
    throw error;
  }
}

async function listAllPermissionSets(
  client: SSOAdminClient,
  instanceArn: string,
) {
  // If we have a cached promise, return it
  if (permissionSetsPromise) {
    return permissionSetsPromise;
  }

  const throttledPaginatedListPermissionSets = (async function* () {
    const paginator = paginateListPermissionSets(
      { client },
      { InstanceArn: instanceArn, MaxResults: 100 },
    );

    for await (const page of paginator) {
      yield await ssoAdminGlobalThrottle(() => Promise.resolve(page))();
    }
  })();

  // Create and cache the promise
  permissionSetsPromise = (async () => {
    const permissionSetArns: string[] = [];
    for await (const page of throttledPaginatedListPermissionSets) {
      if (page.PermissionSets) {
        permissionSetArns.push(...page.PermissionSets);
      }
    }
    const permissionSetDescription = await Promise.all(
      permissionSetArns.map((arn) =>
        ssoAdminGlobalThrottle(() =>
          client.send(
            new DescribePermissionSetCommand({
              InstanceArn: instanceArn,
              PermissionSetArn: arn,
            }),
          ),
        )(),
      ),
    );
    const permissionSets = permissionSetDescription
      .map((permissionSetDescription) => permissionSetDescription.PermissionSet)
      .filter((permissionSet) => permissionSet !== undefined);
    return permissionSets;
  })();

  return permissionSetsPromise;
}

async function createOrGetPermissionSet(
  client: SSOAdminClient,
  params: {
    name: string;
    description: string;
    ssoInstanceArn: string;
  },
) {
  const truncatedName = params.name.slice(0, PERMISSION_SET_NAME_MAX_LENGTH);

  try {
    const createPermissionSetResponse = await ssoAdminGlobalThrottle(() =>
      client.send(
        new CreatePermissionSetCommand({
          Name: truncatedName,
          Description: params.description,
          InstanceArn: params.ssoInstanceArn,
        }),
      ),
    )();

    logger.info("Successfully created permission set", {
      name: truncatedName,
      permissionSetArn:
        createPermissionSetResponse.PermissionSet?.PermissionSetArn,
    });

    await ssoAdminGlobalThrottle(() =>
      client.send(
        new AttachManagedPolicyToPermissionSetCommand({
          InstanceArn: params.ssoInstanceArn,
          PermissionSetArn:
            createPermissionSetResponse.PermissionSet!.PermissionSetArn!,
          ManagedPolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
        }),
      ),
    )();
    logger.info("Successfully attached admin policy");

    return createPermissionSetResponse;
  } catch (error: any) {
    if (error instanceof SSOAdminConflictException) {
      // If creation fails, get all permission sets and look for a match
      const permissionSets = await listAllPermissionSets(
        client,
        params.ssoInstanceArn,
      );
      const existingPermissionSet = permissionSets.find(
        (ps) => ps.Name === truncatedName,
      );

      if (existingPermissionSet) {
        logger.info("Found existing permission set", {
          name: truncatedName,
          permissionSetArn: existingPermissionSet.PermissionSetArn,
        });
        return { PermissionSet: existingPermissionSet };
      }
    }
    throw error;
  }
}
