// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import {
  RestApi,
  RestApiResourceProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  grantIsbAppConfigRead,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class ConfigurationsApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiResourceProps) {
    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
      reportingConfigConfigurationProfileId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const configurationsLambdaFunction = new IsbLambdaFunction(
      scope,
      "ConfigurationsLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for configurations resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "configurations",
          "src",
          "configurations-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: {
          JWT_SECRET_NAME: props.jwtSecret.secretName,
          APP_CONFIG_APPLICATION_ID: configApplicationId,
          APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
          APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
          REPORTING_CONFIG_PROFILE_ID: reportingConfigConfigurationProfileId,
          AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId},/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${reportingConfigConfigurationProfileId}`,
          ACCOUNT_POOL_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns
              .accountPoolConfigParamArn,
        },
        logGroup: restApi.logGroup,
        envSchema: ConfigurationLambdaEnvironmentSchema,
      },
    );

    grantIsbAppConfigRead(
      scope,
      configurationsLambdaFunction,
      globalConfigConfigurationProfileId,
    );
    grantIsbAppConfigRead(
      scope,
      configurationsLambdaFunction,
      reportingConfigConfigurationProfileId,
    );
    addAppConfigExtensionLayer(configurationsLambdaFunction);

    // Grant access to read AccountPoolConfiguration SSM parameter for isbManagedRegions
    grantIsbSsmParameterRead(
      configurationsLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );

    props.jwtSecret.grantRead(configurationsLambdaFunction.lambdaFunction);
    IsbKmsKeys.get(scope, props.namespace).grantEncryptDecrypt(
      configurationsLambdaFunction.lambdaFunction,
    );

    const configurationsResource = restApi.root.addResource("configurations", {
      defaultIntegration: new LambdaIntegration(
        configurationsLambdaFunction.lambdaFunction,
        { allowTestInvoke: true, proxy: true },
      ),
    });
    configurationsResource.addMethod("GET");
    configurationsResource.addMethod("POST");
  }
}
