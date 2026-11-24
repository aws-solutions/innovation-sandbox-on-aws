// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SubscribedEmailEvents } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-events";
import { EmailNotificationEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/email-notification-lambda-environment.js";
import { EventsToLambda } from "@amzn/innovation-sandbox-infrastructure/components/events-to-lambda";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  getIdcRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbDbReadOnly,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { Aws, CfnCondition, CfnOutput, Duration, Fn, Stack } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { EventBus } from "aws-cdk-lib/aws-events";
import {
  Policy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { FilterPattern, MetricFilter } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import path from "node:path";

import {
  NOTIFICATION_CHANNEL_DIMENSION,
  NOTIFICATION_DELIVERY_FAILED_METRIC_TYPE,
  NOTIFICATION_FAILED_METRIC,
  NOTIFICATION_ISB_NAMESPACE_DIMENSION,
  NOTIFICATION_METRIC_NAMESPACE,
} from "@amzn/innovation-sandbox-commons/observability/notification-metrics";

export interface EmailNotificationLambdaProps {
  isbEventBus: EventBus;
  namespace: string;
  idcAccountId: string;
  webAppUrl: string;
  /** ISB-managed customer KMS key used to encrypt the SNS integration topic at rest. */
  kmsKey: Key;
  /**
   * Resolved SesIdentityArn CFN parameter value. Empty string means no
   * delegated identity is configured (hub-account sending, unchanged).
   */
  sesIdentityArn: string;
}

export class EmailNotificationLambda extends Construct {
  /** SNS integration topic, also exposed as a stack output. */
  public readonly integrationTopic: Topic;

  constructor(
    scope: Construct,
    id: string,
    props: EmailNotificationLambdaProps,
  ) {
    super(scope, id);

    const { configTableName } = IsbComputeStack.sharedSpokeConfig.data;

    // Created unconditionally regardless of the SNS toggle, so the ARN is a
    // stable subscription target; toggling later is config-only, not a
    // topic replacement.
    const integrationTopicName = `ISB-${props.namespace}-NotificationIntegration`;
    const integrationTopicArn = Stack.of(scope).formatArn({
      service: "sns",
      resource: integrationTopicName,
    });
    const integrationTopic = new Topic(this, "IntegrationTopic", {
      topicName: integrationTopicName,
      masterKey: props.kmsKey,
      enforceSSL: true,
    });
    this.integrationTopic = integrationTopic;
    new CfnOutput(scope, "NotificationIntegrationTopicArn", {
      value: integrationTopic.topicArn,
      description:
        "SNS topic for ISB notifications when the SNS channel is enabled.",
    });
    props.kmsKey.addToResourcePolicy(
      new PolicyStatement({
        principals: [new ServicePrincipal("sns.amazonaws.com")],
        actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
        conditions: {
          ArnLike: { "aws:SourceArn": integrationTopicArn },
          StringEquals: {
            "aws:SourceAccount": Aws.ACCOUNT_ID,
            "kms:EncryptionContext:aws:sns:topicArn": integrationTopicArn,
          },
        },
      }),
    );

    const lambda = new IsbLambdaFunction(this, id, {
      description: "consumes email notification messages and sends emails",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "notification",
        "email-notification",
        "src",
        "email-notification-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      environment: {
        CONFIG_TABLE_NAME: configTableName,
        ISB_EVENT_BUS: props.isbEventBus.eventBusName,
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        IDC_ROLE_ARN: getIdcRoleArn(scope, props.namespace, props.idcAccountId),
        ISB_NAMESPACE: props.namespace,
        IDC_CONFIG_PARAM_ARN:
          IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
        WEB_APP_URL: props.webAppUrl,
        SNS_INTEGRATION_TOPIC_ARN: integrationTopic.topicArn,
        // Raw parameter value; empty means "not configured" to EmailService.
        // This is a CfnParameter token, always truthy at synth time, so the
        // empty-vs-set distinction only exists once CloudFormation resolves it.
        SES_IDENTITY_ARN: props.sesIdentityArn,
      },
      logGroup: IsbComputeResources.globalLogGroup,
      envSchema: EmailNotificationEnvironmentSchema,
      timeout: Duration.minutes(3),
    });

    IntermediateRole.addTrustedRole(lambda.lambdaFunction.role! as Role);
    grantIsbSsmParameterRead(
      lambda.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );
    grantIsbDbReadOnly(scope, lambda, configTableName);

    // Exact-topic publish grant only, no wildcard or other SNS actions.
    integrationTopic.grantPublish(lambda.lambdaFunction);

    // props.sesIdentityArn is a CfnParameter token, always truthy at synth
    // time, so a JS `if` here can't detect an empty value. CfnCondition +
    // Fn::If is the only way to vary the IAM Resource array on whether an
    // admin actually supplied a value.
    const hasSesIdentityArn = new CfnCondition(scope, "HasSesIdentityArn", {
      expression: Fn.conditionNot(Fn.conditionEquals(props.sesIdentityArn, "")),
    });

    const emailSendPolicy = new Policy(scope, "EmailNotificationSendPolicy", {
      statements: [
        new PolicyStatement({
          actions: ["ses:SendEmail"],
          resources: [
            // Hub-account identities.
            Stack.of(scope).formatArn({
              service: "ses",
              resource: "identity",
              resourceName: "*",
            }),
            Stack.of(scope).formatArn({
              service: "ses",
              resource: "configuration-set",
              resourceName: "*",
            }),
            // Delegated identity, included only when configured. Fn::If
            // resolves to AWS::NoValue when false, so an empty parameter
            // never produces a malformed resource entry.
            Fn.conditionIf(
              hasSesIdentityArn.logicalId,
              props.sesIdentityArn,
              Aws.NO_VALUE,
            ).toString(),
          ],
        }),
      ],
    });
    lambda.lambdaFunction.role?.attachInlinePolicy(emailSendPolicy);
    IsbKmsKeys.get(scope, props.namespace).grantDecrypt(lambda.lambdaFunction);

    // No defaultValue: healthy deployments emit no metric data.
    const notificationFailedFilter = new MetricFilter(
      this,
      "NotificationFailureMetricFilter",
      {
        logGroup: IsbComputeResources.globalLogGroup,
        metricNamespace: NOTIFICATION_METRIC_NAMESPACE,
        metricName: NOTIFICATION_FAILED_METRIC,
        filterPattern: FilterPattern.stringValue(
          "$.notificationMetricType",
          "=",
          NOTIFICATION_DELIVERY_FAILED_METRIC_TYPE,
        ),
        metricValue: "1",
        dimensions: {
          [NOTIFICATION_ISB_NAMESPACE_DIMENSION]: "$.isbNamespace",
          [NOTIFICATION_CHANNEL_DIMENSION]: "$.channel",
        },
      },
    );

    new Alarm(this, "SnsPublishFailureAlarm", {
      alarmDescription:
        "At least one ISB notification could not be published to the SNS integration topic " +
        "in the last hour, after the SDK's own retries. Check structured logs " +
        `(notificationMetricType=${NOTIFICATION_DELIVERY_FAILED_METRIC_TYPE}, channel=SNS) for the error class and ` +
        "affected lease/account; common causes are topic-policy drift, KMS key-policy changes, " +
        "or a transient SNS issue.",
      metric: notificationFailedFilter.metric({
        dimensionsMap: {
          [NOTIFICATION_ISB_NAMESPACE_DIMENSION]: props.namespace,
          [NOTIFICATION_CHANNEL_DIMENSION]: "SNS",
        },
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 1,
      evaluationPeriods: 12,
      datapointsToAlarm: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new Alarm(this, "SesSendFailureAlarm", {
      alarmDescription:
        "At least one ISB notification could not be sent through SES in the last hour, " +
        "after the SDK's own retries. Check structured logs " +
        `(notificationMetricType=${NOTIFICATION_DELIVERY_FAILED_METRIC_TYPE}, channel=SES) for the error class.`,
      metric: notificationFailedFilter.metric({
        dimensionsMap: {
          [NOTIFICATION_ISB_NAMESPACE_DIMENSION]: props.namespace,
          [NOTIFICATION_CHANNEL_DIMENSION]: "SES",
        },
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 1,
      evaluationPeriods: 12,
      datapointsToAlarm: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new EventsToLambda(scope, "EmailEventsToLambda", {
      eventBus: props.isbEventBus,
      lambdaFunction: lambda.lambdaFunction,
      lambdaFunctionProps: {
        maxEventAge: Duration.hours(4),
        retryAttempts: 3,
      },
      ruleProps: {
        eventBus: props.isbEventBus,
        description: "Triggers email notification lambda",
        enabled: true,
        eventPattern: {
          detailType: SubscribedEmailEvents,
        },
      },
    });
  }
}
