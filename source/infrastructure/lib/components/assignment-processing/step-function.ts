// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { Duration } from "aws-cdk-lib";
import { IEventBus, Rule } from "aws-cdk-lib/aws-events";
import { SfnStateMachine } from "aws-cdk-lib/aws-events-targets";
import { Function } from "aws-cdk-lib/aws-lambda";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { IQueue } from "aws-cdk-lib/aws-sqs";
import {
  Chain,
  DefinitionBody,
  IntegrationPattern,
  JsonPath,
  LogLevel,
  Map,
  Pass,
  StateMachine,
  StateMachineType,
  TaskInput,
  Timeout,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  LambdaInvoke,
  SqsSendMessage,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

const STEP_FUNCTION_TIMEOUT_MINUTES = 30;

interface AssignmentProcessorStepFunctionProps {
  eventBus: IEventBus;
  assignmentQueue: IQueue;
  logGroup: LogGroup;
  processorLambda: Function;
}

/**
 * Assignment Processor Step Functions workflow.
 *
 * Workflow:
 * 1. ExtractInput: Extract fields from the EventBridge event detail
 * 2. FanOut: Invoke processor Lambda to union desired + current principal IDs
 * 3. ProcessAssignments (Map): Fan out individual principals to SQS with task tokens
 *    (no action field — workers decide GRANT/REVOKE/NO-OP via JIT diff)
 * 4. HandleCompletion: Invoke processor Lambda to publish events and clear resourceLock
 *
 * Input: EventBridge event with detail matching AssignmentRequestedEventSchema
 */
export class AssignmentProcessorStepFunction extends Construct {
  public readonly stateMachine: StateMachine;

  constructor(
    scope: Construct,
    id: string,
    props: AssignmentProcessorStepFunctionProps,
  ) {
    super(scope, id);
    const { eventBus, assignmentQueue, logGroup, processorLambda } = props;

    const extractInput = new Pass(this, "ExtractInput", {
      parameters: {
        "leaseId.$": "$.detail.leaseId",
        "intent.$": "$.detail.intent",
        "requestedBy.$": "$.detail.requestedBy",
        "lockOwnerId.$": "$.detail.lockOwnerId",
        "leaseOwnerEmail.$": "$.detail.leaseOwnerEmail",
        "executionArn.$": "$$.Execution.Id",
        "requestedAt.$": "$$.Execution.StartTime",
      },
    });

    const fanOut = new LambdaInvoke(this, "FanOut", {
      lambdaFunction: processorLambda,
      payload: TaskInput.fromObject({
        action: "FAN_OUT",
        "leaseId.$": "$.leaseId",
        "intent.$": "$.intent",
        "lockOwnerId.$": "$.lockOwnerId",
        "leaseOwnerEmail.$": "$.leaseOwnerEmail",
        "requestedBy.$": "$.requestedBy",
        "executionArn.$": "$.executionArn",
      }),
      integrationPattern: IntegrationPattern.REQUEST_RESPONSE,
      resultSelector: {
        "workItems.$": "$.Payload.workItems",
        "accountId.$": "$.Payload.accountId",
        "preExistingPrincipals.$": "$.Payload.preExistingPrincipals",
      },
      resultPath: "$.fanOutResult",
    });

    const sendToSqs = new SqsSendMessage(this, "SendAssignmentToSQS", {
      queue: assignmentQueue,
      integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      messageBody: TaskInput.fromObject({
        "leaseId.$": "$.leaseId",
        "intent.$": "$.intent",
        "executionArn.$": "$.executionArn",
        "requestedBy.$": "$.requestedBy",
        "requestedAt.$": "$.requestedAt",
        "leaseOwnerEmail.$": "$.leaseOwnerEmail",
        "accountId.$": "$.accountId",
        "principalId.$": "$.item.principalId",
        "principalType.$": "$.item.principalType",
        "displayName.$": "$.item.displayName",
        "email.$": "$.item.email",
        "permissionSetArn.$": "$.item.permissionSetArn",
        taskToken: JsonPath.taskToken,
      }),
      heartbeatTimeout: Timeout.duration(Duration.minutes(10)),
    });

    const itemErrorHandler = new Pass(this, "HandleItemError", {
      comment:
        "Catches individual assignment processing errors within the Map state",
    });
    sendToSqs.addCatch(itemErrorHandler, {
      errors: ["States.ALL"],
      resultPath: "$.itemError",
    });

    const mapState = new Map(this, "ProcessAssignments", {
      itemsPath: "$.fanOutResult.workItems",
      itemSelector: {
        "leaseId.$": "$.leaseId",
        "intent.$": "$.intent",
        "executionArn.$": "$.executionArn",
        "requestedBy.$": "$.requestedBy",
        "requestedAt.$": "$.requestedAt",
        "leaseOwnerEmail.$": "$.leaseOwnerEmail",
        "accountId.$": "$.fanOutResult.accountId",
        "item.$": "$$.Map.Item.Value",
      },
      maxConcurrency: 20,
      resultPath: "$.mapResults",
    });
    mapState.itemProcessor(Chain.start(sendToSqs));

    const handleCompletion = new LambdaInvoke(this, "HandleCompletion", {
      lambdaFunction: processorLambda,
      payload: TaskInput.fromObject({
        action: "HANDLE_COMPLETION",
        "leaseId.$": "$.leaseId",
        "intent.$": "$.intent",
        "lockOwnerId.$": "$.lockOwnerId",
        "leaseOwnerEmail.$": "$.leaseOwnerEmail",
        "requestedBy.$": "$.requestedBy",
        "accountId.$": "$.fanOutResult.accountId",
        "executionArn.$": "$.executionArn",
        "fannedOutPrincipals.$": "$.fanOutResult.workItems",
        "preExistingPrincipals.$": "$.fanOutResult.preExistingPrincipals",
      }),
      integrationPattern: IntegrationPattern.REQUEST_RESPONSE,
      resultPath: "$.completionResult",
    });

    const definition = Chain.start(extractInput)
      .next(fanOut)
      .next(mapState)
      .next(handleCompletion);

    this.stateMachine = new StateMachine(
      this,
      "AssignmentProcessorStateMachine",
      {
        definitionBody: DefinitionBody.fromChainable(definition),
        stateMachineType: StateMachineType.STANDARD,
        timeout: Duration.minutes(STEP_FUNCTION_TIMEOUT_MINUTES),
        tracingEnabled: true,
        logs: {
          destination: logGroup,
          level: LogLevel.ALL,
          includeExecutionData: true,
        },
      },
    );

    assignmentQueue.grantSendMessages(this.stateMachine);

    processorLambda.grantInvoke(this.stateMachine);

    new Rule(this, "AssignmentRequestedRule", {
      eventBus,
      description:
        "Routes AssignmentRequested events to the Assignment Processor Step Function",
      targets: [new SfnStateMachine(this.stateMachine)],
      eventPattern: { detailType: [EventDetailTypes.AssignmentRequested] },
    });
  }
}
