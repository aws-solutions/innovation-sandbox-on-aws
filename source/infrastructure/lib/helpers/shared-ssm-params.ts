// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Construct } from "constructs";

import { TokenSafeAccountPoolConfig } from "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/account-pool-stack-config.js";
import { DataConfig } from "@amzn/innovation-sandbox-commons/data/data-stack-config/data-stack-config.js";
import { IdcConfig } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/idc-stack-config.js";
import {
  sharedAccountPoolSsmParamName,
  sharedDataSsmParamName,
  sharedIdcSsmParamName,
} from "@amzn/innovation-sandbox-commons/types/isb-types";
import { SharedJsonParamResolver } from "@amzn/innovation-sandbox-infrastructure/components/custom-resources/shared-json-param-resolver";
import { Stack } from "aws-cdk-lib";

export interface SharedSpokeConfig {
  idc: IdcConfig;
  accountPool: TokenSafeAccountPoolConfig;
  data: DataConfig;
  parameterArns: {
    idcConfigParamArn: string;
    accountPoolConfigParamArn: string;
    dataConfigParamArn: string;
  };
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
      availableOuId: sharedJsonParamResolver.availableOuId,
      activeOuId: sharedJsonParamResolver.activeOuId,
      frozenOuId: sharedJsonParamResolver.frozenOuId,
      cleanupOuId: sharedJsonParamResolver.cleanupOuId,
      quarantineOuId: sharedJsonParamResolver.quarantineOuId,
      entryOuId: sharedJsonParamResolver.entryOuId,
      exitOuId: sharedJsonParamResolver.exitOuId,
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
      blueprintTable: sharedJsonParamResolver.blueprintTable,
      tableKmsKeyId: sharedJsonParamResolver.tableKmsKeyId,
      solutionVersion: sharedJsonParamResolver.dataSolutionVersion,
      supportedSchemas: sharedJsonParamResolver.dataSupportedSchemas,
    },
    parameterArns: {
      idcConfigParamArn,
      accountPoolConfigParamArn,
      dataConfigParamArn,
    },
  };
}
