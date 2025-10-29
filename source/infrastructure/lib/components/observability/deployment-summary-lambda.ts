// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Construct } from "constructs";
import path from "path";

import { DeploymentSummaryLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/deployment-summary-lambda-environment";
import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { AnonymizedMetricsProps } from "@amzn/innovation-sandbox-infrastructure/components/observability/anonymized-metrics-reporting";
import {
  getOrgMgtRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbAppConfigRead,
  grantIsbDbReadOnly,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class DeploymentSummaryLambda extends Construct {
  constructor(scope: Construct, id: string, props: AnonymizedMetricsProps) {
    super(scope, id);

    const { sandboxOuId } = IsbComputeStack.sharedSpokeConfig.accountPool;
    const {
      accountTable,
      leaseTemplateTable,
      configApplicationId,
      configEnvironmentId,
      globalConfigConfigurationProfileId,
      reportingConfigConfigurationProfileId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const lambda = new IsbLambdaFunction(scope, "ReportingFunction", {
      description:
        "Periodic heartbeat lambda for summarizing the solution deployment",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "metrics",
        "deployment-summary-heartbeat",
        "src",
        "deployment-summary-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      environment: {
        METRICS_URL: props.metricsUrl,
        SOLUTION_ID: props.solutionId,
        SOLUTION_VERSION: props.solutionVersion,
        METRICS_UUID: props.deploymentUUID,
        HUB_ACCOUNT_ID: props.hubAccountId,
        ORG_MGT_ACCOUNT_ID: props.orgManagementAccountId,
        ACCOUNT_TABLE_NAME: accountTable,
        LEASE_TEMPLATE_TABLE_NAME: leaseTemplateTable,
        ISB_NAMESPACE: props.namespace,
        SANDBOX_OU_ID: sandboxOuId,
        ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
          scope,
          props.namespace,
          props.orgManagementAccountId,
        ),
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        APP_CONFIG_APPLICATION_ID: configApplicationId,
        APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
        APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
        REPORTING_CONFIG_PROFILE_ID: reportingConfigConfigurationProfileId,
        AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId},/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${reportingConfigConfigurationProfileId},`,
        IS_STABLE_TAGGING_ENABLED: props.isStableTaggingEnabled,
      },
      logGroup: IsbComputeResources.globalLogGroup,
      envSchema: DeploymentSummaryLambdaEnvironmentSchema,
      reservedConcurrentExecutions: 1,
    });

    grantIsbDbReadOnly(scope, lambda, leaseTemplateTable, accountTable);
    grantIsbAppConfigRead(scope, lambda, globalConfigConfigurationProfileId);
    grantIsbAppConfigRead(scope, lambda, reportingConfigConfigurationProfileId);
    addAppConfigExtensionLayer(lambda);

    IntermediateRole.addTrustedRole(lambda.lambdaFunction.role! as Role);

    const role = new Role(scope, "LambdaInvokeRole", {
      description:
        "allows EventBridgeScheduler to invoke Innovation Sandbox's heartbeat metrics lamdba",
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
    });

    lambda.lambdaFunction.grantInvoke(role);

    new CfnSchedule(scope, "ScheduledEvent", {
      description: "triggers heartbeat metrics lambda to execute once per day",
      scheduleExpression: "rate(1 day)",
      flexibleTimeWindow: {
        mode: "FLEXIBLE",
        maximumWindowInMinutes: 60,
      },
      target: {
        input: JSON.stringify({
          action: "gather-metrics",
        }),
        retryPolicy: {
          maximumRetryAttempts: 2,
        },
        arn: lambda.lambdaFunction.functionArn,
        roleArn: role.roleArn,
      },
    });
  }
}
