// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { AssignmentProcessorEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/assignment-processor-environment.js";
import { AssignmentWorkerEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/assignment-worker-environment.js";
import { AssignmentProcessorStepFunction } from "@amzn/innovation-sandbox-infrastructure/components/assignment-processing/step-function";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  getIdcRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbDbReadOnly,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { Duration } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { IEventBus } from "aws-cdk-lib/aws-events";
import { Effect, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { StateMachine } from "aws-cdk-lib/aws-stepfunctions";
import { Construct } from "constructs";
import path from "node:path";

const PROCESSOR_LAMBDA_TIMEOUT_MINUTES = 5;

// SQS redrive maxReceiveCount. Shared between the queue's redrive policy and the
// worker (via env) so the worker can detect its final attempt and fail the Step
// Function task before the message is dead-lettered.
const ASSIGNMENT_MAX_RECEIVE_COUNT = 5;

export interface AssignmentProcessingProps {
  namespace: string;
  eventBus: IEventBus;
  idcAccountId: string;
}

/**
 * Assignment Processing infrastructure for multi-user lease management.
 */
export class AssignmentProcessing extends Construct {
  public readonly queue: Queue;
  public readonly deadLetterQueue: Queue;
  public readonly dlqAlarm: Alarm;
  public readonly stateMachine: StateMachine;

  constructor(scope: Construct, id: string, props: AssignmentProcessingProps) {
    super(scope, id);

    const kmsKey = IsbKmsKeys.get(scope, props.namespace);

    this.deadLetterQueue = new Queue(this, "AssignmentProcessingDLQ", {
      queueName: `Isb-${props.namespace}-AssignmentProcessingDLQ`,
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    this.queue = new Queue(this, "AssignmentProcessingQueue", {
      queueName: `Isb-${props.namespace}-AssignmentProcessingQueue`,
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: kmsKey,
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(120),
      retentionPeriod: Duration.hours(1),
      receiveMessageWaitTime: Duration.seconds(5),
      deadLetterQueue: {
        maxReceiveCount: ASSIGNMENT_MAX_RECEIVE_COUNT,
        queue: this.deadLetterQueue,
      },
    });

    this.dlqAlarm = new Alarm(this, "AssignmentDLQAlarm", {
      alarmDescription:
        "Assignment processing dead-letter queue has visible messages — " +
        "indicates IDC operations that failed after all retries and require manual investigation",
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const { principalTable, leaseTable } =
      IsbComputeStack.sharedSpokeConfig.data;

    const processorLambda = new IsbLambdaFunction(this, "ProcessorLambda", {
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "assignment-processor",
        "src",
        "assignment-processor-handler.ts",
      ),
      description:
        "Reads desired assignment state and handles completion for the Assignment Processor Step Function",
      namespace: props.namespace,
      timeout: Duration.minutes(PROCESSOR_LAMBDA_TIMEOUT_MINUTES),
      envSchema: AssignmentProcessorEnvironmentSchema,
      environment: {
        LEASE_TABLE_NAME: leaseTable,
        PRINCIPAL_TABLE_NAME: principalTable,
        ISB_EVENT_BUS: props.eventBus.eventBusName,
        ISB_NAMESPACE: props.namespace,
        IDC_CONFIG_PARAM_ARN:
          IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
      },
      logGroup: IsbComputeResources.globalLogGroup,
    });

    grantIsbDbReadWrite(this, processorLambda, leaseTable);
    grantIsbDbReadOnly(this, processorLambda, principalTable);

    grantIsbSsmParameterRead(
      processorLambda.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );

    processorLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["events:PutEvents"],
        resources: [props.eventBus.eventBusArn],
      }),
    );

    const stepFunction = new AssignmentProcessorStepFunction(
      this,
      "StepFunction",
      {
        eventBus: props.eventBus,
        assignmentQueue: this.queue,
        logGroup: IsbComputeResources.globalLogGroup,
        processorLambda: processorLambda.lambdaFunction,
      },
    );

    this.stateMachine = stepFunction.stateMachine;

    // Assignment Worker Lambda — SQS consumer with reserved concurrency 5
    // Processes individual IDC CreateAccountAssignment/DeleteAccountAssignment operations
    const workerLambda = new IsbLambdaFunction(this, "WorkerLambda", {
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "assignment-worker",
        "src",
        "assignment-worker-handler.ts",
      ),
      description:
        "Processes IDC account assignment operations from the Assignment Processing Queue",
      namespace: props.namespace,
      timeout: Duration.seconds(60),
      reservedConcurrentExecutions: 5,
      envSchema: AssignmentWorkerEnvironmentSchema,
      environment: {
        PRINCIPAL_TABLE_NAME: principalTable,
        LEASE_TABLE_NAME: leaseTable,
        IDC_CONFIG_PARAM_ARN:
          IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
        IDC_ROLE_ARN: getIdcRoleArn(scope, props.namespace, props.idcAccountId),
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        ASSIGNMENT_MAX_RECEIVE_COUNT: String(ASSIGNMENT_MAX_RECEIVE_COUNT),
      },
      logGroup: IsbComputeResources.globalLogGroup,
    });

    workerLambda.lambdaFunction.addEventSource(
      new SqsEventSource(this.queue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    grantIsbDbReadWrite(this, workerLambda, principalTable);
    grantIsbDbReadOnly(this, workerLambda, leaseTable);

    // SendTaskSuccess/SendTaskFailure do not support resource-level permissions
    // (callbacks are authorized by the opaque taskToken), so Resource must be "*".
    // Scoping to the state machine ARN causes an implicit deny at runtime.
    workerLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
        resources: ["*"],
      }),
    );

    IntermediateRole.addTrustedRole(workerLambda.lambdaFunction.role! as Role);

    grantIsbSsmParameterRead(
      workerLambda.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );

    kmsKey.grantEncryptDecrypt(workerLambda.lambdaFunction);
  }
}
