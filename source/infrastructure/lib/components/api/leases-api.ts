// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, Stack } from "aws-cdk-lib";
import { LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { Effect, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { LeaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
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

export class LeasesApi {
  constructor(restApi: RestApi, scope: Construct, props: RestApiResourceProps) {
    const {
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
      reportingConfigConfigurationProfileId,
      leaseTemplateTable,
      leaseTable,
      accountTable,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const leasesLambdaFunction = new IsbLambdaFunction(
      scope,
      "LeasesLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for leases resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "leases",
          "src",
          "leases-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: {
          JWT_SECRET_NAME: props.jwtSecret.secretName,
          APP_CONFIG_APPLICATION_ID: configApplicationId,
          APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
          REPORTING_CONFIG_PROFILE_ID: reportingConfigConfigurationProfileId,
          APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
          AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId},/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${reportingConfigConfigurationProfileId},`,
          ISB_NAMESPACE: props.namespace,
          ACCOUNT_TABLE_NAME: accountTable,
          LEASE_TABLE_NAME: leaseTable,
          LEASE_TEMPLATE_TABLE_NAME: leaseTemplateTable,
          ISB_EVENT_BUS: props.isbEventBus.eventBusName,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          IDC_ROLE_ARN: getIdcRoleArn(
            scope,
            props.namespace,
            props.idcAccountId,
          ),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            scope,
            props.namespace,
            props.orgMgtAccountId,
          ),
          BLUEPRINT_TABLE_NAME:
            IsbComputeStack.sharedSpokeConfig.data.blueprintTable,
          SANDBOX_ACCOUNT_ROLE_NAME: getSandboxAccountRoleName(props.namespace),
          ACCOUNT_POOL_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns
              .accountPoolConfigParamArn,
          IDC_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
        },
        logGroup: restApi.logGroup,
        envSchema: LeaseLambdaEnvironmentSchema,
      },
    );

    grantIsbSsmParameterRead(
      leasesLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );
    grantIsbSsmParameterRead(
      leasesLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );
    grantIsbDbReadWrite(
      scope,
      leasesLambdaFunction,
      leaseTable,
      leaseTemplateTable,
      accountTable,
      IsbComputeStack.sharedSpokeConfig.data.blueprintTable,
    );
    grantIsbAppConfigRead(
      scope,
      leasesLambdaFunction,
      globalConfigConfigurationProfileId,
    );
    grantIsbAppConfigRead(
      scope,
      leasesLambdaFunction,
      reportingConfigConfigurationProfileId,
    );
    addAppConfigExtensionLayer(leasesLambdaFunction);

    props.isbEventBus.grantPutEventsTo(leasesLambdaFunction.lambdaFunction);

    // Grant CloudFormation StackSet read-only permissions for blueprint validation
    leasesLambdaFunction.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudformation:DescribeStackSet"],
        resources: [
          Stack.of(scope).formatArn({
            service: "cloudformation",
            resource: "stackset",
            resourceName: "*:*",
          }),
        ],
      }),
    );

    props.jwtSecret.grantRead(leasesLambdaFunction.lambdaFunction);
    IsbKmsKeys.get(scope, props.namespace).grantEncryptDecrypt(
      leasesLambdaFunction.lambdaFunction,
    );

    // Grant CloudFormation permissions for stack instance cleanup during manual lease termination.
    // POST /leases/{leaseId}/terminate calls deleteStackInstancesMetadata() which needs DeleteStackInstances.
    grantCfnStackSetCleanupPermissions(
      leasesLambdaFunction.lambdaFunction.role! as Role,
    );

    IntermediateRole.addTrustedRole(
      leasesLambdaFunction.lambdaFunction.role! as Role,
    );

    const leasesResource = restApi.root.addResource("leases", {
      defaultIntegration: new LambdaIntegration(
        leasesLambdaFunction.lambdaFunction,
        {
          allowTestInvoke: true,
          proxy: true,
        },
      ),
    });
    leasesResource.addMethod("GET");
    leasesResource.addMethod("POST");

    const leaseIdResource = leasesResource.addResource("{leaseId}");
    leaseIdResource.addMethod("GET");
    leaseIdResource.addMethod("PATCH");

    const leaseReviewResource = leaseIdResource.addResource("review");
    leaseReviewResource.addMethod("POST");

    const leaseFreezeResource = leaseIdResource.addResource("freeze");
    leaseFreezeResource.addMethod("POST");

    const leaseUnfreezeResource = leaseIdResource.addResource("unfreeze");
    leaseUnfreezeResource.addMethod("POST");

    const leaseTerminateResource = leaseIdResource.addResource("terminate");
    leaseTerminateResource.addMethod("POST");
  }
}
