// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";
import path from "path";

import { LeaseTemplateLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import {
  RestApi,
  RestApiProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  AppConfigReadPolicyStatement,
  grantIsbDbReadWrite,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class LeaseTemplatesApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiProps) {
    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
      reportingConfigConfigurationProfileId,
      leaseTemplateTable,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const leaseTemplatesLambdaFunction = new IsbLambdaFunction(
      scope,
      "LeaseTemplatesLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for lease-templates resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "lease-templates",
          "src",
          "lease-templates-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: {
          APP_CONFIG_APPLICATION_ID: configApplicationId,
          APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
          APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
          REPORTING_CONFIG_PROFILE_ID: reportingConfigConfigurationProfileId,
          AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId},/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${reportingConfigConfigurationProfileId}`,
          LEASE_TEMPLATE_TABLE_NAME: leaseTemplateTable,
        },
        bundling: {
          externalModules: [
            "@middy/core",
            "@aws-lambda-powertools/logger",
            "@aws-lambda-powertools/tracer",
            "@aws-lambda-powertools/parser",
          ],
        },
        logGroup: restApi.logGroup,
        envSchema: LeaseTemplateLambdaEnvironmentSchema,
      },
    );

    grantIsbDbReadWrite(
      scope,
      leaseTemplatesLambdaFunction,
      leaseTemplateTable,
    );
    addAppConfigExtensionLayer(leaseTemplatesLambdaFunction);

    leaseTemplatesLambdaFunction.lambdaFunction.addToRolePolicy(
      new AppConfigReadPolicyStatement(scope, {
        configurations: [
          {
            applicationId: configApplicationId,
            environmentId: configEnvironmentId,
            configurationProfileId: globalConfigConfigurationProfileId,
          },
          {
            applicationId: configApplicationId,
            environmentId: configEnvironmentId,
            configurationProfileId: reportingConfigConfigurationProfileId,
          },
        ],
      }),
    );

    const leaseTemplatesResource = restApi.root.addResource("leaseTemplates", {
      defaultIntegration: new LambdaIntegration(
        leaseTemplatesLambdaFunction.lambdaFunction,
        { allowTestInvoke: true, proxy: true },
      ),
    });
    leaseTemplatesResource.addMethod("GET");
    leaseTemplatesResource.addMethod("POST");

    const leaseTemplateNameResource = leaseTemplatesResource.addResource(
      "{leaseTemplateName}",
    );
    leaseTemplateNameResource.addMethod("GET");
    leaseTemplateNameResource.addMethod("PUT");
    leaseTemplateNameResource.addMethod("DELETE");
  }
}
