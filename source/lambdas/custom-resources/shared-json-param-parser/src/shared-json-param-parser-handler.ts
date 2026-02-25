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

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  SharedJsonParamEnvironment,
  SharedJsonParamEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/shared-json-param-parser-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";

type SharedJsonParamContext = Context &
  ValidatedEnvironment<SharedJsonParamEnvironment>;

export interface SharedJsonParamArns {
  idcConfigParamArn: string;
  accountPoolConfigParamArn: string;
  dataConfigParamArn: string;
}

const tracer = new Tracer();
const logger = new Logger();

const onCreateOrUpdate = async (
  event:
    | CloudFormationCustomResourceCreateEvent
    | CloudFormationCustomResourceUpdateEvent,
  context: SharedJsonParamContext,
): Promise<CdkCustomResourceResponse> => {
  const { idcConfigParamArn, accountPoolConfigParamArn, dataConfigParamArn } =
    event.ResourceProperties as unknown as SharedJsonParamArns;

  logger.info({
    message: "Shared SSM parameter arns",
    idcConfigParamArn,
    accountPoolConfigParamArn,
    dataConfigParamArn,
  });

  const idcConfigStore = IsbServices.idcStackConfigStore({
    IDC_CONFIG_PARAM_ARN: idcConfigParamArn,
    USER_AGENT_EXTRA: context.env.USER_AGENT_EXTRA,
  });
  const validatedIdcConfig = await idcConfigStore.get();
  logger.info({
    ...validatedIdcConfig,
    message: "Validated Idc Configuration",
  });

  const accountPoolConfigStore = IsbServices.accountPoolStackConfigStore({
    ACCOUNT_POOL_CONFIG_PARAM_ARN: accountPoolConfigParamArn,
    USER_AGENT_EXTRA: context.env.USER_AGENT_EXTRA,
  });
  const validatedAccountPoolConfig = await accountPoolConfigStore.get();
  logger.info({
    ...validatedAccountPoolConfig,
    message: "Validated AccountPool Configuration",
  });

  const dataConfigStore = IsbServices.dataStackConfigStore({
    DATA_CONFIG_PARAM_ARN: dataConfigParamArn,
    USER_AGENT_EXTRA: context.env.USER_AGENT_EXTRA,
  });
  const validatedDataConfig = await dataConfigStore.get();
  logger.info({
    ...validatedDataConfig,
    message: "Validated Data Configuration",
  });

  return {
    Data: {
      //Idc
      identityStoreId: validatedIdcConfig.identityStoreId,
      ssoInstanceArn: validatedIdcConfig.ssoInstanceArn,
      adminGroupId: validatedIdcConfig.adminGroupId,
      managerGroupId: validatedIdcConfig.managerGroupId,
      userGroupId: validatedIdcConfig.userGroupId,
      adminPermissionSetArn: validatedIdcConfig.adminPermissionSetArn,
      managerPermissionSetArn: validatedIdcConfig.managerPermissionSetArn,
      userPermissionSetArn: validatedIdcConfig.userPermissionSetArn,
      idcSolutionVersion: validatedIdcConfig.solutionVersion,
      idcSupportedSchemas: validatedIdcConfig.supportedSchemas,
      //AccountPool
      sandboxOuId: validatedAccountPoolConfig.sandboxOuId,
      availableOuId: validatedAccountPoolConfig.availableOuId,
      activeOuId: validatedAccountPoolConfig.activeOuId,
      frozenOuId: validatedAccountPoolConfig.frozenOuId,
      cleanupOuId: validatedAccountPoolConfig.cleanupOuId,
      quarantineOuId: validatedAccountPoolConfig.quarantineOuId,
      entryOuId: validatedAccountPoolConfig.entryOuId,
      exitOuId: validatedAccountPoolConfig.exitOuId,
      accountPoolSolutionVersion: validatedAccountPoolConfig.solutionVersion,
      accountPoolSupportedSchemas: validatedAccountPoolConfig.supportedSchemas,
      isbManagedRegions: validatedAccountPoolConfig.isbManagedRegions,
      //Data
      configApplicationId: validatedDataConfig.configApplicationId,
      configEnvironmentId: validatedDataConfig.configEnvironmentId,
      globalConfigConfigurationProfileId:
        validatedDataConfig.globalConfigConfigurationProfileId,
      nukeConfigConfigurationProfileId:
        validatedDataConfig.nukeConfigConfigurationProfileId,
      reportingConfigConfigurationProfileId:
        validatedDataConfig.reportingConfigConfigurationProfileId,
      accountTable: validatedDataConfig.accountTable,
      leaseTemplateTable: validatedDataConfig.leaseTemplateTable,
      leaseTable: validatedDataConfig.leaseTable,
      blueprintTable: validatedDataConfig.blueprintTable,
      tableKmsKeyId: validatedDataConfig.tableKmsKeyId,
      dataSolutionVersion: validatedDataConfig.solutionVersion,
      dataSupportedSchemas: validatedDataConfig.supportedSchemas,
    },
    PhysicalResourceId:
      (event as any).PhysicalResourceId ?? "SharedJsonParamParser",
  };
};

const onDelete = async (
  event: CloudFormationCustomResourceDeleteEvent,
): Promise<CdkCustomResourceResponse> => {
  return {
    Data: {
      status: "success",
    },
    PhysicalResourceId: event.PhysicalResourceId,
  };
};

const lambdaHandler = async (
  event: CdkCustomResourceEvent,
  context: SharedJsonParamContext,
): Promise<CdkCustomResourceResponse> => {
  switch (event.RequestType) {
    case "Create":
      logger.info("SharedJsonParamParser on Create");
      return onCreateOrUpdate(event, context);
    case "Update":
      logger.info("SharedJsonParamParser on Update");
      return onCreateOrUpdate(event, context);
    case "Delete":
      logger.info("SharedJsonParamParser on Delete");
      return onDelete(event);
  }
};

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: SharedJsonParamEnvironmentSchema,
  moduleName: "shared-json-param-parser",
}).handler(lambdaHandler);
