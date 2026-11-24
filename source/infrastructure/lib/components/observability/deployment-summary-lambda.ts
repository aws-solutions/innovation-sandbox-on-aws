// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ArnFormat, Aws, Duration, Stack } from "aws-cdk-lib";
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Construct } from "constructs";
import path from "node:path";

import { DeploymentSummaryLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/deployment-summary-lambda-environment";
import {
  buildM2mRolePrefix,
  M2M_ROLE_NAME_INFIX,
} from "@amzn/innovation-sandbox-commons/utils/m2m-role-arn";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { AnonymizedMetricsProps } from "@amzn/innovation-sandbox-infrastructure/components/observability/anonymized-metrics-reporting";
import {
  getOrgMgtRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbDbReadOnly,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class DeploymentSummaryLambda extends Construct {
  constructor(scope: Construct, id: string, props: AnonymizedMetricsProps) {
    super(scope, id);

    const {
      accountTable,
      leaseTemplateTable,
      blueprintTable,
      configTableName,
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
        CONFIG_TABLE_NAME: configTableName,
        METRICS_URL: props.metricsUrl,
        SOLUTION_ID: props.solutionId,
        SOLUTION_VERSION: props.solutionVersion,
        METRICS_UUID: props.deploymentUUID,
        HUB_ACCOUNT_ID: props.hubAccountId,
        ORG_MGT_ACCOUNT_ID: props.orgManagementAccountId,
        ACCOUNT_TABLE_NAME: accountTable,
        LEASE_TEMPLATE_TABLE_NAME: leaseTemplateTable,
        LEASE_TABLE_NAME: IsbComputeStack.sharedSpokeConfig.data.leaseTable,
        BLUEPRINT_TABLE_NAME: blueprintTable,
        PRINCIPAL_TABLE_NAME:
          IsbComputeStack.sharedSpokeConfig.data.principalTable,
        ISB_NAMESPACE: props.namespace,
        ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
          scope,
          props.namespace,
          props.orgManagementAccountId,
        ),
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        IS_STABLE_TAGGING_ENABLED: props.isStableTaggingEnabled,
        ACCOUNT_POOL_CONFIG_PARAM_ARN:
          IsbComputeStack.sharedSpokeConfig.parameterArns
            .accountPoolConfigParamArn,
        USER_PERMISSION_SET_ARN:
          IsbComputeStack.sharedSpokeConfig.idc.userPermissionSetArn,
        WAF_WEB_ACL_NAME: props.wafWebAclName,
        WAF_REGION: Aws.REGION,
        NOTIFICATION_TOPIC_ARN: props.notificationIntegrationTopic.topicArn,
        SES_IDENTITY_ARN: props.sesIdentityArn,
      },
      logGroup: IsbComputeResources.globalLogGroup,
      envSchema: DeploymentSummaryLambdaEnvironmentSchema,
      reservedConcurrentExecutions: 1,
      timeout: Duration.minutes(15),
    });

    grantIsbDbReadOnly(
      scope,
      lambda,
      leaseTemplateTable,
      accountTable,
      blueprintTable,
      configTableName,
      IsbComputeStack.sharedSpokeConfig.data.principalTable,
      IsbComputeStack.sharedSpokeConfig.data.leaseTable,
    );
    grantIsbSsmParameterRead(
      lambda.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );
    lambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudformation:GetTemplateSummary"],
        resources: [
          Stack.of(scope).formatArn({
            service: "cloudformation",
            resource: "stackset",
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            resourceName: "*",
          }),
        ],
      }),
    );
    lambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["access-analyzer:ValidatePolicy"],
        resources: ["*"],
      }),
    );
    // Reads the WAF caller-mix CountedRequests metrics and notification failure
    // metrics. GetMetricData has no resource-level scoping.
    lambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudwatch:GetMetricData"],
        resources: ["*"],
      }),
    );
    // GetTopicAttributes returns counts without subscription endpoints.
    lambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sns:GetTopicAttributes"],
        resources: [props.notificationIntegrationTopic.topicArn],
      }),
    );
    // For counting deployed M2M client roles for the heartbeat metric.
    // iam:ListRoles has no resource-level scoping; tag reads are scoped to this
    // deployment's M2M roles by their dedicated path + name pattern.
    lambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["iam:ListRoles"],
        resources: ["*"],
      }),
    );
    lambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["iam:ListRoleTags"],
        resources: [
          Stack.of(scope).formatArn({
            service: "iam",
            region: "",
            resource: "role",
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            resourceName: `${buildM2mRolePrefix(props.namespace)}/${props.namespace}-${M2M_ROLE_NAME_INFIX}-*`,
          }),
        ],
      }),
    );

    IntermediateRole.addTrustedRole(lambda.lambdaFunction.role! as Role);

    const role = new Role(scope, "LambdaInvokeRole", {
      description:
        "allows EventBridgeScheduler to invoke Innovation Sandbox's heartbeat metrics lambda",
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
