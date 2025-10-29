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
import { z } from "zod";

import {
  SharedJsonParamEnvironment,
  SharedJsonParamEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/shared-json-param-parser-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";

const IdcConfigSchema = z.object({
  identityStoreId: z.string(),
  ssoInstanceArn: z.string(),
  adminGroupId: z.string(),
  managerGroupId: z.string(),
  userGroupId: z.string(),
  adminPermissionSetArn: z.string(),
  managerPermissionSetArn: z.string(),
  userPermissionSetArn: z.string(),
  solutionVersion: z.string(),
  supportedSchemas: z.string(),
});

export type IdcConfig = z.infer<typeof IdcConfigSchema>;

const AccountPoolConfigSchema = z.object({
  sandboxOuId: z.string(),
  solutionVersion: z.string(),
  supportedSchemas: z.string(),
  isbManagedRegions: z
    .string()
    .transform((value) => value.split(","))
    .transform((value) => value.map((v) => v.trim()))
    .transform((value) => value.toString()),
});
export type AccountPoolConfig = z.infer<typeof AccountPoolConfigSchema>;

const DataConfigSchema = z.object({
  configApplicationId: z.string(),
  configEnvironmentId: z.string(),
  globalConfigConfigurationProfileId: z.string(),
  nukeConfigConfigurationProfileId: z.string(),
  reportingConfigConfigurationProfileId: z.string(),
  accountTable: z.string(),
  leaseTemplateTable: z.string(),
  leaseTable: z.string(),
  tableKmsKeyId: z.string(),
  solutionVersion: z.string(),
  supportedSchemas: z.string(),
});
export type DataConfig = z.infer<typeof DataConfigSchema>;

type SourceStack = "Idc" | "AccountPool" | "Data";

type SharedJsonParamContext = Context &
  ValidatedEnvironment<SharedJsonParamEnvironment>;

const schemaMap: Record<SourceStack, z.ZodObject<any>> = {
  Idc: IdcConfigSchema,
  AccountPool: AccountPoolConfigSchema,
  Data: DataConfigSchema,
};

export interface SharedJsonParamArns {
  idcConfigParamArn: string;
  accountPoolConfigParamArn: string;
  dataConfigParamArn: string;
}

const tracer = new Tracer();
const logger = new Logger();

function parseConfig(sourceStack: SourceStack, paramValue: string) {
  const configJSON = JSON.parse(paramValue);
  const parsedConfig = schemaMap[sourceStack].strict().safeParse(configJSON);
  if (!parsedConfig.success) {
    const errorMessage = `Invalid configuration from ${sourceStack} stack provided`;
    logger.critical(`${errorMessage}: ${parsedConfig.error}`);
    throw new Error(errorMessage);
  }
  const validatedConfig = parsedConfig.data;
  logger.info({
    ...validatedConfig,
    message: `Validated ${sourceStack} Configuration`,
  });
  return validatedConfig;
}

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
  const ssmClient = IsbClients.ssm(context.env);
  const idcConfigString = await ssmClient.getIsbParameter(idcConfigParamArn);
  const validatedIdcConfig = parseConfig("Idc", idcConfigString);

  const accountPoolConfigString = await ssmClient.getIsbParameter(
    accountPoolConfigParamArn,
  );
  const validatedAccountPoolConfig = parseConfig(
    "AccountPool",
    accountPoolConfigString,
  );

  const dataConfigString = await ssmClient.getIsbParameter(dataConfigParamArn);
  const validatedDataConfig = parseConfig("Data", dataConfigString);

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
