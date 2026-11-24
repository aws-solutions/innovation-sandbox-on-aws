// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { Duration } from "aws-cdk-lib";
import { Rule, RuleProps } from "aws-cdk-lib/aws-events";
import { SqsQueue, SqsQueueProps } from "aws-cdk-lib/aws-events-targets";
import { ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export const EVENTS_TO_SQS_MAX_RECEIVE_COUNT = 3;

export interface EventsToSqsToLambdaProps {
  namespace: string;
  /**
   * Derives the construct ids (`{name}Queue`, `{name}DLQ`, `{name}Rule`), the
   * queue names, and the FIFO message group. Changing it on a deployed stack
   * replaces the queues.
   */
  name: string;
  lambdaFunction: IFunction;
  ruleProps: RuleProps;
  /** Must be at least the consumer Lambda's timeout. */
  visibilityTimeout: Duration;
  retentionPeriod: Duration;
  deliveryDelay?: Duration;
  deadLetterQueueRetentionPeriod?: Duration;
  /** EventBridge target options, e.g. retry policy. */
  sqsQueueProps?: SqsQueueProps;
}

/**
 * EventBridge rule → encrypted FIFO SQS queue (with FIFO DLQ) → Lambda.
 *
 * Every event goes to a single message group, so the Lambda receives one
 * message at a time and never sees a second while one is in flight.
 */
export class EventsToSqsToLambda extends Construct {
  public readonly queue: Queue;
  public readonly deadLetterQueue: Queue;

  constructor(scope: Construct, id: string, props: EventsToSqsToLambdaProps) {
    super(scope, id);
    const kmsKey = IsbKmsKeys.get(scope, props.namespace);

    this.deadLetterQueue = new Queue(this, `${props.name}DLQ`, {
      queueName: `Isb-${props.namespace}-${props.name}DLQ.fifo`,
      fifo: true,
      contentBasedDeduplication: true,
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      enforceSSL: true,
      retentionPeriod: props.deadLetterQueueRetentionPeriod,
    });

    this.queue = new Queue(this, `${props.name}Queue`, {
      queueName: `Isb-${props.namespace}-${props.name}Queue.fifo`,
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      retentionPeriod: props.retentionPeriod,
      visibilityTimeout: props.visibilityTimeout,
      deliveryDelay: props.deliveryDelay,
      fifo: true,
      contentBasedDeduplication: true,
      deadLetterQueue: {
        maxReceiveCount: EVENTS_TO_SQS_MAX_RECEIVE_COUNT,
        queue: this.deadLetterQueue,
      },
      enforceSSL: true,
    });

    const rule = new Rule(this, `${props.name}Rule`, props.ruleProps);
    rule.addTarget(
      new SqsQueue(this.queue, {
        messageGroupId: props.name,
        ...props.sqsQueueProps,
      }),
    );
    this.queue.grantSendMessages(new ServicePrincipal("events.amazonaws.com"));

    props.lambdaFunction.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: 1,
      }),
    );

    kmsKey.grantEncryptDecrypt(new ServicePrincipal("events.amazonaws.com"));
    kmsKey.grantEncryptDecrypt(new ServicePrincipal("sqs.amazonaws.com"));
  }
}
