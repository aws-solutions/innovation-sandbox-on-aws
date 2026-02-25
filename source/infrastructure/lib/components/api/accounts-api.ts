// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws } from "aws-cdk-lib";
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { AccountLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import {
  RestApi,
  RestApiResourceProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  getIdcRoleArn,
  getOrgMgtRoleArn,
  getSandboxAccountRoleName,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantCfnStackSetCleanupPermissions,
  grantIsbAppConfigRead,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class AccountsApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiResourceProps) {
    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
      accountTable,
      leaseTable,
      blueprintTable,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const accountsLambdaFunction = new IsbLambdaFunction(
      scope,
      "AccountsLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for account resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "accounts",
          "src",
          "accounts-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: {
          JWT_SECRET_NAME: props.jwtSecret.secretName,
          APP_CONFIG_APPLICATION_ID: configApplicationId,
          APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
          APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
          AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId}`,
          ACCOUNT_TABLE_NAME: accountTable,
          LEASE_TABLE_NAME: leaseTable,
          BLUEPRINT_TABLE_NAME: blueprintTable,
          SANDBOX_ACCOUNT_ROLE_NAME: getSandboxAccountRoleName(props.namespace),
          ISB_NAMESPACE: props.namespace,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            scope,
            props.namespace,
            props.orgMgtAccountId,
          ),
          IDC_ROLE_ARN: getIdcRoleArn(
            scope,
            props.namespace,
            props.idcAccountId,
          ),
          ACCOUNT_POOL_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns
              .accountPoolConfigParamArn,
          IDC_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
          ISB_EVENT_BUS: props.isbEventBus.eventBusName,
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          IDC_ACCOUNT_ID: props.idcAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
        },
        logGroup: restApi.logGroup,
        envSchema: AccountLambdaEnvironmentSchema,
      },
    );

    grantIsbSsmParameterRead(
      accountsLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );
    grantIsbSsmParameterRead(
      accountsLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );
    grantIsbDbReadWrite(
      scope,
      accountsLambdaFunction,
      IsbComputeStack.sharedSpokeConfig.data.accountTable,
      IsbComputeStack.sharedSpokeConfig.data.leaseTable,
      IsbComputeStack.sharedSpokeConfig.data.blueprintTable,
    );
    grantIsbAppConfigRead(
      scope,
      accountsLambdaFunction,
      globalConfigConfigurationProfileId,
    );
    addAppConfigExtensionLayer(accountsLambdaFunction);
    props.isbEventBus.grantPutEventsTo(accountsLambdaFunction.lambdaFunction);

    props.jwtSecret.grantRead(accountsLambdaFunction.lambdaFunction);
    IsbKmsKeys.get(scope, props.namespace).grantEncryptDecrypt(
      accountsLambdaFunction.lambdaFunction,
    );

    // Grant CloudFormation permissions for stack instance cleanup during account ejection.
    grantCfnStackSetCleanupPermissions(
      accountsLambdaFunction.lambdaFunction.role! as Role,
    );

    IntermediateRole.addTrustedRole(
      accountsLambdaFunction.lambdaFunction.role! as Role,
    );

    const accountsResource = restApi.root.addResource("accounts", {
      defaultIntegration: new LambdaIntegration(
        accountsLambdaFunction.lambdaFunction,
        { allowTestInvoke: true, proxy: true },
      ),
    });
    accountsResource.addMethod("GET");
    accountsResource.addMethod("POST");

    const accountIdResource = accountsResource.addResource("{awsAccountId}");
    accountIdResource.addMethod("GET");

    const accountRetryCleanupResource =
      accountIdResource.addResource("retryCleanup");
    accountRetryCleanupResource.addMethod("POST");

    const accountEjectResource = accountIdResource.addResource("eject");
    accountEjectResource.addMethod("POST");

    const accountsUnregisteredResource =
      accountsResource.addResource("unregistered");
    accountsUnregisteredResource.addMethod("GET");
  }
}
