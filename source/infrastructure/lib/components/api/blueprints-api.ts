// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws } from "aws-cdk-lib";
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { BlueprintLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-lambda-environment.js";
import {
  RestApi,
  RestApiResourceProps,
} from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  getSandboxAccountRoleName,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantCfnStackSetReadOnly,
  grantIsbAppConfigRead,
  grantIsbDbReadWrite,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class BlueprintsApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiResourceProps) {
    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
      leaseTemplateTable,
      blueprintTable,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const blueprintsLambdaFunction = new IsbLambdaFunction(
      scope,
      "BlueprintsLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for blueprints resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "blueprints",
          "src",
          "blueprints-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: {
          JWT_SECRET_NAME: props.jwtSecret.secretName,
          APP_CONFIG_APPLICATION_ID: configApplicationId,
          APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
          APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
          AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId}`,
          ISB_NAMESPACE: props.namespace,
          BLUEPRINT_TABLE_NAME: blueprintTable,
          LEASE_TEMPLATE_TABLE_NAME: leaseTemplateTable,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          SANDBOX_ACCOUNT_ROLE_NAME: getSandboxAccountRoleName(props.namespace),
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
        },
        logGroup: restApi.logGroup,
        envSchema: BlueprintLambdaEnvironmentSchema,
      },
    );

    // Grant DynamoDB permissions
    grantIsbDbReadWrite(
      scope,
      blueprintsLambdaFunction,
      blueprintTable,
      leaseTemplateTable,
    );

    // Grant AppConfig permissions
    grantIsbAppConfigRead(
      scope,
      blueprintsLambdaFunction,
      globalConfigConfigurationProfileId,
    );

    // Add AppConfig extension layer
    addAppConfigExtensionLayer(blueprintsLambdaFunction);

    // Grant CloudFormation read-only permissions for StackSet discovery and validation
    grantCfnStackSetReadOnly(
      blueprintsLambdaFunction.lambdaFunction.role! as Role,
    );

    props.jwtSecret.grantRead(blueprintsLambdaFunction.lambdaFunction);
    IsbKmsKeys.get(scope, props.namespace).grantEncryptDecrypt(
      blueprintsLambdaFunction.lambdaFunction,
    );

    // API Gateway routes
    const blueprintsResource = restApi.root.addResource("blueprints", {
      defaultIntegration: new LambdaIntegration(
        blueprintsLambdaFunction.lambdaFunction,
        {
          allowTestInvoke: true,
          proxy: true,
        },
      ),
    });

    // GET /blueprints - List all blueprints
    blueprintsResource.addMethod("GET");

    // POST /blueprints - Register new blueprint
    blueprintsResource.addMethod("POST");

    // GET /blueprints/stacksets - List available StackSets
    const stacksetsResource = blueprintsResource.addResource("stacksets");
    stacksetsResource.addMethod("GET");

    // GET /blueprints/{blueprintId} - Get blueprint details
    const blueprintIdResource = blueprintsResource.addResource("{blueprintId}");
    blueprintIdResource.addMethod("GET");

    // PUT /blueprints/{blueprintId} - Update blueprint
    blueprintIdResource.addMethod("PUT");

    // DELETE /blueprints/{blueprintId} - Unregister blueprint
    blueprintIdResource.addMethod("DELETE");
  }
}
