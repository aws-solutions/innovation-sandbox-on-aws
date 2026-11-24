// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { SandboxAgentMemoryCleanupLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/sandbox-agent-memory-cleanup-lambda-environment.js";
import {
  EVENTS_TO_SQS_MAX_RECEIVE_COUNT,
  EventsToSqsToLambda,
} from "@amzn/innovation-sandbox-infrastructure/components/events-to-sqs-to-lambda";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { Duration } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { IEventBus } from "aws-cdk-lib/aws-events";
import {
  ArnPrincipal,
  Effect,
  PolicyStatement,
  Role,
} from "aws-cdk-lib/aws-iam";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import path from "node:path";

const LAMBDA_TIMEOUT_MINUTES = 5;

export interface SandboxAgentMemoryCleanupProps {
  namespace: string;
  eventBus: IEventBus;
  /** Memory Access Role assumed (with a per-lease session policy) to delete a
   * terminated lease's AgentCore Memory. */
  memoryAccessRole: Role;
  /** ARN of the User `CfnMemory` resource. */
  userMemoryArn: string;
}

/**
 * Deletes a terminated lease's LTM records for every user on the lease:
 * EventBridge `LeaseTerminated` → SQS FIFO → cleanup Lambda, via
 * {@link EventsToSqsToLambda}. STM events are left to the User memory's 30-day
 * expiry.
 *
 * Kept off the ordered account-lifecycle FIFO queue on purpose: a retry there
 * would block every other lifecycle event behind it, and each retry waits out
 * the 30-minute visibility timeout.
 *
 * Its own queue is FIFO with a single message group, not for ordering, but so
 * at most one message is ever in flight. That matches the Lambda's reserved
 * concurrency of 1: on a standard queue the SQS poller invokes concurrently
 * during a burst, the reserved concurrency throttles the extras, and every
 * throttled receive counts toward `maxReceiveCount`, sending cleanups to the
 * DLQ that never ran. The trade-off is that a lease that keeps failing delays
 * the cleanups behind it until it reaches the DLQ; that delay is harmless
 * because a terminated lease's memory is already unreachable.
 */
export class SandboxAgentMemoryCleanup extends Construct {
  public readonly queue: Queue;
  public readonly deadLetterQueue: Queue;
  public readonly dlqAlarm: Alarm;

  constructor(
    scope: Construct,
    id: string,
    props: SandboxAgentMemoryCleanupProps,
  ) {
    super(scope, id);

    const lambda = new IsbLambdaFunction(this, "MemoryCleanupLambda", {
      description:
        "Deletes a terminated lease's Sandbox Agent long-term memory records",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "sandbox-agent",
        "memory-cleanup",
        "src",
        "memory-cleanup-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      environment: {
        MEMORY_ACCESS_ROLE_ARN: props.memoryAccessRole.roleArn,
        USER_MEMORY_ARN: props.userMemoryArn,
        MAX_RECEIVE_COUNT: String(EVENTS_TO_SQS_MAX_RECEIVE_COUNT),
      },
      logGroup: IsbComputeResources.globalLogGroup,
      envSchema: SandboxAgentMemoryCleanupLambdaEnvironmentSchema,
      timeout: Duration.minutes(LAMBDA_TIMEOUT_MINUTES),
      // One cleanup at a time keeps the batch deletes well inside AgentCore's
      // shared per-account quota for memory APIs. Safe only because the FIFO
      // single message group never offers a second message while one is in
      // flight; see the class comment.
      reservedConcurrentExecutions: 1,
    });

    lambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [props.memoryAccessRole.roleArn],
      }),
    );
    props.memoryAccessRole.assumeRolePolicy?.addStatements(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        principals: [new ArnPrincipal(lambda.lambdaFunction.role!.roleArn)],
      }),
    );

    const pipeline = new EventsToSqsToLambda(this, "EventsToSqsToLambda", {
      namespace: props.namespace,
      name: "SandboxAgentMemoryCleanup",
      lambdaFunction: lambda.lambdaFunction,
      ruleProps: {
        eventBus: props.eventBus,
        description:
          "Triggers Sandbox Agent memory cleanup on lease termination",
        enabled: true,
        eventPattern: { detailType: [EventDetailTypes.LeaseTerminated] },
      },
      // Hold each message well past the 60-90s LTM extraction window: records
      // extracted after the final verify are never swept (LTM has no expiry, and
      // AgentCore exposes no in-progress extraction signal to wait on). 15 min is
      // the SQS maximum; the delay is safe because a terminated lease's memory is
      // unreachable in the meantime (the Worker rejects terminated leases).
      deliveryDelay: Duration.minutes(15),
      // AWS recommends 6x the consumer timeout for Lambda event sources; it
      // also spaces retries out well beyond the extraction window.
      visibilityTimeout: Duration.minutes(LAMBDA_TIMEOUT_MINUTES * 6),
      retentionPeriod: Duration.days(3),
      deadLetterQueueRetentionPeriod: Duration.days(14),
    });
    this.queue = pipeline.queue;
    this.deadLetterQueue = pipeline.deadLetterQueue;

    // Alarms only once every retry is exhausted, not on a first attempt that
    // a retry then fixes.
    this.dlqAlarm = new Alarm(this, "MemoryCleanupDLQAlarm", {
      alarmDescription:
        "A lease-termination AgentCore Memory cleanup failed after all retries. " +
        "The terminated lease's LTM records may persist, and LTM records never " +
        "expire. Find the `leaseId` and failing `phase` via " +
        "structured logs (`logDetailType=MemoryCleanupFailed`) in the ISB global " +
        "log group, then redrive the DLQ; cleanup is idempotent and safe to re-run.",
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}
