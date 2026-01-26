// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { AccountLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import { sharedIdcSsmParamName } from "@amzn/innovation-sandbox-commons/types/isb-types";
import {
  RestApi,
  RestApiProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  getIdcRoleArn,
  getOrgMgtRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbAppConfigRead,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { Aws } from "aws-cdk-lib";

export class AccountsApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiProps) {
    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
      accountTable,
      leaseTable,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const { sandboxOuId } = IsbComputeStack.sharedSpokeConfig.accountPool;

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
          APP_CONFIG_APPLICATION_ID: configApplicationId,
          APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
          APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
          AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId}`,
          ACCOUNT_TABLE_NAME: accountTable,
          LEASE_TABLE_NAME: leaseTable,
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
          ISB_EVENT_BUS: props.isbEventBus.eventBusName,
          SANDBOX_OU_ID: sandboxOuId,
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
      sharedIdcSsmParamName(props.namespace),
      props.idcAccountId,
    );
    grantIsbDbReadWrite(
      scope,
      accountsLambdaFunction,
      IsbComputeStack.sharedSpokeConfig.data.accountTable,
      IsbComputeStack.sharedSpokeConfig.data.leaseTable,
    );
    grantIsbAppConfigRead(
      scope,
      accountsLambdaFunction,
      globalConfigConfigurationProfileId,
    );
    addAppConfigExtensionLayer(accountsLambdaFunction);
    props.isbEventBus.grantPutEventsTo(accountsLambdaFunction.lambdaFunction);

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

    const accountQuarantineResource =
      accountIdResource.addResource("quarantine");
    accountQuarantineResource.addMethod("POST");

    const accountsUnregisteredResource =
      accountsResource.addResource("unregistered");
    accountsUnregisteredResource.addMethod("GET");
  }
}
