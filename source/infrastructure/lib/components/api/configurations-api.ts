// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import path from "path";

import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import {
  RestApi,
  RestApiProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { grantIsbAppConfigRead } from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class ConfigurationsApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiProps) {
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
          APP_CONFIG_APPLICATION_ID: configApplicationId,
          APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
          APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
          REPORTING_CONFIG_PROFILE_ID: reportingConfigConfigurationProfileId,
          AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId},/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${reportingConfigConfigurationProfileId}`,
          ISB_MANAGED_REGIONS:
            IsbComputeStack.sharedSpokeConfig.accountPool.isbManagedRegions,
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
