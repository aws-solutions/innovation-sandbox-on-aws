// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Construct } from "constructs";

import {
  sharedAccountPoolSsmParamName,
  sharedDataSsmParamName,
  sharedIdcSsmParamName,
} from "@amzn/innovation-sandbox-commons/types/isb-types";
import { SharedJsonParamResolver } from "@amzn/innovation-sandbox-infrastructure/components/custom-resources/shared-json-param-resolver";
import {
  AccountPoolConfig,
  DataConfig,
  IdcConfig,
} from "@amzn/innovation-sandbox-shared-json-param-parser/src/shared-json-param-parser-handler";
import { Stack } from "aws-cdk-lib";

export interface SharedSpokeConfig {
  idc: IdcConfig;
  accountPool: AccountPoolConfig;
  data: DataConfig;
}

export function getSharedSsmParamValues(
  scope: Construct,
  namespace: string,
  idcAccountId: string,
  orgMgtAccountId: string,
): SharedSpokeConfig {
  const idcConfigParamArn = Stack.of(scope).formatArn({
    service: "ssm",
    account: idcAccountId,
    resource: "parameter",
    resourceName: sharedIdcSsmParamName(namespace),
  });

  const accountPoolConfigParamArn = Stack.of(scope).formatArn({
    service: "ssm",
    account: orgMgtAccountId,
    resource: "parameter",
    resourceName: sharedAccountPoolSsmParamName(namespace),
  });

  const dataConfigParamArn = Stack.of(scope).formatArn({
    service: "ssm",
    resource: "parameter",
    resourceName: sharedDataSsmParamName(namespace),
  });

  const sharedJsonParamResolver = new SharedJsonParamResolver(
    scope,
    "IsbSpokeConfigJsonParamResolver",
    {
      idcConfigParamArn,
      accountPoolConfigParamArn,
      dataConfigParamArn,
      namespace,
    },
  );

  return {
    idc: {
      identityStoreId: sharedJsonParamResolver.identityStoreId,
      ssoInstanceArn: sharedJsonParamResolver.ssoInstanceArn,
      adminGroupId: sharedJsonParamResolver.adminGroupId,
      managerGroupId: sharedJsonParamResolver.managerGroupId,
      userGroupId: sharedJsonParamResolver.userGroupId,
      adminPermissionSetArn: sharedJsonParamResolver.adminPermissionSetArn,
      managerPermissionSetArn: sharedJsonParamResolver.managerPermissionSetArn,
      userPermissionSetArn: sharedJsonParamResolver.userPermissionSetArn,
      solutionVersion: sharedJsonParamResolver.idcSolutionVersion,
      supportedSchemas: sharedJsonParamResolver.idcSupportedSchemas,
    },
    accountPool: {
      sandboxOuId: sharedJsonParamResolver.sandboxOuId,
      solutionVersion: sharedJsonParamResolver.accountPoolSolutionVersion,
      supportedSchemas: sharedJsonParamResolver.accountPoolSupportedSchemas,
      isbManagedRegions: sharedJsonParamResolver.isbManagedRegions,
    },
    data: {
      configApplicationId: sharedJsonParamResolver.configApplicationId,
      configEnvironmentId: sharedJsonParamResolver.configEnvironmentId,
      globalConfigConfigurationProfileId:
        sharedJsonParamResolver.globalConfigConfigurationProfileId,
      nukeConfigConfigurationProfileId:
        sharedJsonParamResolver.nukeConfigConfigurationProfileId,
      reportingConfigConfigurationProfileId:
        sharedJsonParamResolver.reportingConfigConfigurationProfileId,
      accountTable: sharedJsonParamResolver.accountTable,
      leaseTemplateTable: sharedJsonParamResolver.leaseTemplateTable,
      leaseTable: sharedJsonParamResolver.leaseTable,
      tableKmsKeyId: sharedJsonParamResolver.tableKmsKeyId,
      solutionVersion: sharedJsonParamResolver.dataSolutionVersion,
      supportedSchemas: sharedJsonParamResolver.dataSupportedSchemas,
    },
  };
}
