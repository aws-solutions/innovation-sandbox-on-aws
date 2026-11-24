// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ITable } from "aws-cdk-lib/aws-dynamodb";
import {
  EventBus,
  EventField,
  Rule,
  RuleTargetInput,
} from "aws-cdk-lib/aws-events";
import {
  AccountPrincipal,
  Effect,
  PolicyStatement,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { CfnResourcePolicy } from "aws-cdk-lib/aws-logs";
import { ITopic } from "aws-cdk-lib/aws-sns";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

import { AccountDriftMonitoringLambda } from "@amzn/innovation-sandbox-infrastructure/components/account-management/account-drift-monitoring-lambda";
import { AccountLifecycleManagementLambda } from "@amzn/innovation-sandbox-infrastructure/components/account-management/account-lifecycle-management-lambda";
import { LeaseMonitoringLambda } from "@amzn/innovation-sandbox-infrastructure/components/account-management/lease-monitoring-lambda";
import { TokenPollLambda } from "@amzn/innovation-sandbox-infrastructure/components/account-management/token-poll-lambda";
import { EmailNotificationLambda } from "@amzn/innovation-sandbox-infrastructure/components/notification/email-notification";
import { getIsbEventBusName } from "@amzn/innovation-sandbox-infrastructure/helpers/isb-events";
import { getPermissionSetEventForwardingRoleArn } from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";

export type IsbEventBackplaneProps = {
  namespace: string;
  kmsKey: Key;
  readonly bedrockPriceTable: ITable;
  readonly orgMgtAccountId: string;
  readonly idcAccountId: string;
  readonly webAppUrl: string;
  /** The observability sinks' region-to-sink-id map, read by the token poll. */
  readonly sinkIdsJson: string;
  /** Resolved SesIdentityArn CFN parameter, threaded through to EmailNotificationLambda. */
  readonly sesIdentityArn: string;
};

/**
 * ISB resources responsible for continual core account/lease management operations that occur
 * independently of direct user action.
 */
export class IsbInternalCore {
  readonly eventBus: EventBus;
  readonly leaseMonitoringLambda;
  readonly accountLifecycleManagementLambda;
  readonly accountDriftMonitoringLambda;
  readonly notificationIntegrationTopic: ITopic;

  constructor(scope: Construct, props: IsbEventBackplaneProps) {
    this.eventBus = new EventBus(scope, "ISBEventBus", {
      eventBusName: getIsbEventBusName(props.namespace),
      description: "core event bus for all ISB activity",
      kmsKey: props.kmsKey,
      deadLetterQueue: new Queue(scope, "ISBEventBusDLQ", {
        queueName: `ISB-${props.namespace}-ISBEventBus-DLQ`,
        encryption: QueueEncryption.KMS,
        encryptionMasterKey: props.kmsKey,
        enforceSSL: true,
      }),
    });
    this.eventBus.addToResourcePolicy(
      new PolicyStatement({
        sid: "AllowIdcAccountPermissionSetEvents",
        actions: ["events:PutEvents"],
        principals: [new AccountPrincipal(props.idcAccountId)],
        resources: [this.eventBus.eventBusArn],
        conditions: {
          StringEquals: {
            "aws:PrincipalAccount": props.idcAccountId,
          },
          ArnEquals: {
            "aws:PrincipalArn": getPermissionSetEventForwardingRoleArn(
              scope,
              props.namespace,
              props.idcAccountId,
            ),
          },
        },
      }),
    );

    IsbComputeResources.globalLogGroup.addToResourcePolicy(
      new PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        effect: Effect.ALLOW,
        principals: [
          new ServicePrincipal("events.amazonaws.com"),
          new ServicePrincipal("delivery.logs.amazonaws.com"),
        ],
        resources: [IsbComputeResources.globalLogGroup.logGroupArn],
      }),
    );

    // Namespace the log group's auto-named (construct-id-derived) resource policy so
    // multiple ISB instances in one account/region don't collide on the policy name.
    const globalLogGroupPolicy =
      IsbComputeResources.globalLogGroup.node.findChild("Policy").node
        .defaultChild as CfnResourcePolicy;
    globalLogGroupPolicy.policyName = `${props.namespace}-ISBLogGroupPolicy`;

    const dlq = new Queue(scope, "DLQ", {
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: props.kmsKey,
      enforceSSL: true,
    });

    new Rule(scope, "ISBEventBusLogging", {
      description: "logs all events that get sent to the ISB event bus",
      eventBus: this.eventBus,
      targets: [
        {
          bind: () => ({
            arn: IsbComputeResources.globalLogGroup.logGroupArn,
            input: RuleTargetInput.fromObject({
              message: `ISBEventBus received ${EventField.fromPath("$.detail-type")} event`,
              timestamp: EventField.fromPath("$.time"),
            }),
            targetResource: IsbComputeResources.globalLogGroup,
            deadLetterConfig: { arn: dlq.queueArn },
            retryPolicy: {
              maximumRetryAttempts: 20,
            },
          }),
        },
      ],
      eventPattern: {
        source: [{ prefix: "" }] as any[],
      },
    });

    this.leaseMonitoringLambda = new LeaseMonitoringLambda(
      scope,
      "LeaseMonitoring",
      {
        isbEventBus: this.eventBus,
        namespace: props.namespace,
        orgMgtAccountId: props.orgMgtAccountId,
      },
    );

    new TokenPollLambda(scope, "TokenPoll", {
      isbEventBus: this.eventBus,
      namespace: props.namespace,
      bedrockPriceTable: props.bedrockPriceTable,
      sinkIdsJson: props.sinkIdsJson,
    });

    this.accountLifecycleManagementLambda =
      new AccountLifecycleManagementLambda(
        scope,
        "SandboxAccountLifecycleManagement",
        {
          isbEventBus: this.eventBus,
          namespace: props.namespace,
          orgManagementAccountId: props.orgMgtAccountId,
          idcAccountId: props.idcAccountId,
        },
      );

    this.accountDriftMonitoringLambda = new AccountDriftMonitoringLambda(
      scope,
      "AccountDriftMonitoring",
      {
        isbEventBus: this.eventBus,
        namespace: props.namespace,
        orgMgtAccountId: props.orgMgtAccountId,
      },
    );

    const emailNotification = new EmailNotificationLambda(
      scope,
      "EmailNotification",
      {
        isbEventBus: this.eventBus,
        namespace: props.namespace,
        idcAccountId: props.idcAccountId,
        webAppUrl: props.webAppUrl,
        kmsKey: props.kmsKey,
        sesIdentityArn: props.sesIdentityArn,
      },
    );
    this.notificationIntegrationTopic = emailNotification.integrationTopic;
  }
}
