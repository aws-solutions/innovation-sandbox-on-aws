// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Duration } from "aws-cdk-lib";
import { IEventBus, Rule } from "aws-cdk-lib/aws-events";
import { SfnStateMachine } from "aws-cdk-lib/aws-events-targets";
import { Function } from "aws-cdk-lib/aws-lambda";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import {
  Chain,
  Choice,
  Condition,
  DefinitionBody,
  IntegrationPattern,
  JsonPath,
  LogLevel,
  Pass,
  StateMachine,
  StateMachineType,
  TaskInput,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";

import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";

interface BlueprintDeploymentStepFunctionProps {
  eventBus: IEventBus;
  deploymentOrchestratorLambda: Function;
  logGroup: LogGroup;
  stepFunctionTimeoutMinutes: number;
}

/**
 * Blueprint Deployment Step Functions workflow.
 *
 * Workflow (Step Functions controls flow, Lambda handles operations):
 * 1. CREATE: Validate StackSet (exists, ID matches, SELF_MANAGED) + CreateStackInstances
 *    - Lambda receives $$.Execution.StartTime for timeout calculations
 *    - Returns: { success: true, operationId, status: "SUCCEEDED" } OR
 *               { success: false, operationId: "N/A", status: "FAILED", errorMessage }
 * 2. Choice: Did CREATE succeed?
 *    - No: PUBLISH_RESULT (FAILED) - validation failures
 *    - Yes: Continue to CHECK_STATUS polling loop
 * 3. CHECK_STATUS: Poll CloudFormation + check timeout (Lambda calculates elapsed time)
 *    - Returns: { status: "SUCCEEDED"|"FAILED"|"IN_PROGRESS", errorMessage? }
 *    - Timeout handled internally by Lambda (returns status="FAILED")
 * 4. Choice: Is deployment complete?
 *    - SUCCEEDED: PUBLISH_RESULT (success)
 *    - FAILED: PUBLISH_RESULT (failure) - includes timeout failures
 *    - IN_PROGRESS: Wait 30s, loop back to CHECK_STATUS
 * 5. PUBLISH_RESULT: Send BlueprintDeploymentSucceeded/Failed event
 *
 * All failure paths (validation, deployment, Lambda crashes) publish events for proper lease handling.
 * Input is immutable - all state machine data stored in nested 'context' object.
 */
export class BlueprintDeploymentStepFunction extends Construct {
  public readonly stateMachine: StateMachine;

  constructor(
    scope: Construct,
    id: string,
    props: BlueprintDeploymentStepFunctionProps,
  ) {
    super(scope, id);

    const {
      eventBus,
      deploymentOrchestratorLambda,
      logGroup,
      stepFunctionTimeoutMinutes,
    } = props;

    // Add Lambda error to context when Lambda invocation fails (crashes, timeouts)
    // This ensures all failure paths publish events for proper lease handling
    // CRITICAL: Preserve original input structure at root level for consistent JSONPath access
    const addLambdaErrorToContext = new Pass(this, "AddLambdaErrorToContext", {
      parameters: {
        "detail.$": "$.detail",
        "Execution.$": "$.Execution",
        context: {
          deploymentResult: {
            success: false,
            operationId: "N/A",
            status: "FAILED",
            errorMessage: JsonPath.format(
              "Step Functions error - Lambda function invocation failed: {}",
              JsonPath.stringAt("$.Error.Cause"),
            ),
          },
        },
      },
    });

    // CREATE action: Validate + CreateStackInstances
    // Lambda returns consistent structure for both success and failure:
    // { success: true, operationId, status: "SUCCEEDED" } OR
    // { success: false, operationId: "N/A", status: "FAILED", errorMessage }
    const createStackInstancesTask = new LambdaInvoke(
      this,
      "CreateStackInstances",
      {
        lambdaFunction: deploymentOrchestratorLambda,
        payload: TaskInput.fromObject({
          action: "CREATE",
          blueprintId: JsonPath.stringAt("$.detail.blueprintId"),
          leaseId: JsonPath.stringAt("$.detail.leaseId"),
          accountId: JsonPath.stringAt("$.detail.accountId"),
          stackSetId: JsonPath.stringAt("$.detail.stackSetId"),
          regions: JsonPath.listAt("$.detail.regions"),
          regionConcurrencyType: JsonPath.stringAt(
            "$.detail.regionConcurrencyType",
          ),
          maxConcurrentPercentage: JsonPath.numberAt(
            "$.detail.maxConcurrentPercentage",
          ),
          failureTolerancePercentage: JsonPath.numberAt(
            "$.detail.failureTolerancePercentage",
          ),
          concurrencyMode: JsonPath.stringAt("$.detail.concurrencyMode"),
          executionStartTime: JsonPath.stringAt("$$.Execution.StartTime"),
        }),
        integrationPattern: IntegrationPattern.REQUEST_RESPONSE,
        resultSelector: {
          "success.$": "$.Payload.success",
          "operationId.$": "$.Payload.operationId",
          "status.$": "$.Payload.status",
          "errorMessage.$": "$.Payload.errorMessage",
        },
        resultPath: "$.context.deploymentResult",
      },
    );

    // Catch Lambda invocation failures and route to PUBLISH_RESULT
    createStackInstancesTask.addCatch(addLambdaErrorToContext, {
      errors: ["States.ALL"],
      resultPath: "$.Error",
    });

    // CHECK_STATUS action: Poll + timeout check (Lambda calculates elapsed time)
    const checkDeploymentStatusTask = new LambdaInvoke(
      this,
      "CheckDeploymentStatus",
      {
        lambdaFunction: deploymentOrchestratorLambda,
        payload: TaskInput.fromObject({
          action: "CHECK_STATUS",
          blueprintId: JsonPath.stringAt("$.detail.blueprintId"),
          leaseId: JsonPath.stringAt("$.detail.leaseId"),
          accountId: JsonPath.stringAt("$.detail.accountId"),
          stackSetId: JsonPath.stringAt("$.detail.stackSetId"),
          operationId: JsonPath.stringAt(
            "$.context.deploymentResult.operationId",
          ),
          deploymentTimeoutMinutes: JsonPath.numberAt(
            "$.detail.deploymentTimeoutMinutes",
          ),
          executionStartTime: JsonPath.stringAt("$$.Execution.StartTime"),
        }),
        integrationPattern: IntegrationPattern.REQUEST_RESPONSE,
        resultSelector: {
          "operationId.$": "$.Payload.operationId",
          "status.$": "$.Payload.status",
          "errorMessage.$": "$.Payload.errorMessage",
        },
        resultPath: "$.context.deploymentResult",
      },
    );

    // Catch Lambda invocation failures and route to PUBLISH_RESULT
    checkDeploymentStatusTask.addCatch(addLambdaErrorToContext, {
      errors: ["States.ALL"],
      resultPath: "$.Error",
    });

    // PUBLISH_RESULT action: Send event
    // Uses deploymentResult which contains either:
    // - Initial CREATE result (validation failures)
    // - Updated CHECK_STATUS result (deployment outcomes)
    const publishDeploymentResultTask = new LambdaInvoke(
      this,
      "PublishDeploymentResult",
      {
        lambdaFunction: deploymentOrchestratorLambda,
        payload: TaskInput.fromObject({
          action: "PUBLISH_RESULT",
          blueprintId: JsonPath.stringAt("$.detail.blueprintId"),
          leaseId: JsonPath.stringAt("$.detail.leaseId"),
          userEmail: JsonPath.stringAt("$.detail.userEmail"),
          accountId: JsonPath.stringAt("$.detail.accountId"),
          blueprintName: JsonPath.stringAt("$.detail.blueprintName"),
          operationId: JsonPath.stringAt(
            "$.context.deploymentResult.operationId",
          ),
          status: JsonPath.stringAt("$.context.deploymentResult.status"),
          errorMessage: JsonPath.stringAt(
            "$.context.deploymentResult.errorMessage",
          ),
        }),
        integrationPattern: IntegrationPattern.REQUEST_RESPONSE,
      },
    );

    // Wait state for polling (30 seconds between status checks)
    const waitForDeployment = new Wait(this, "WaitForDeployment", {
      time: WaitTime.duration(Duration.seconds(30)),
    });

    // Choice: Did CREATE succeed?
    const evaluateCreateResult = new Choice(this, "EvaluateCreateResult")
      .when(
        Condition.booleanEquals("$.context.deploymentResult.success", false),
        publishDeploymentResultTask, // Validation failure path
      )
      .otherwise(checkDeploymentStatusTask); // Deployment path

    // Choice: Is deployment complete? (Lambda handles timeout internally)
    const evaluateDeploymentStatus = new Choice(
      this,
      "EvaluateDeploymentStatus",
    )
      .when(
        Condition.stringEquals(
          "$.context.deploymentResult.status",
          "SUCCEEDED",
        ),
        publishDeploymentResultTask,
      )
      .when(
        Condition.stringEquals("$.context.deploymentResult.status", "FAILED"),
        publishDeploymentResultTask,
      )
      .otherwise(waitForDeployment); // Continue polling

    // Define workflow: CREATE → Choice → (CHECK_STATUS → Choice → Wait loop) → PUBLISH_RESULT
    const definition = Chain.start(createStackInstancesTask).next(
      evaluateCreateResult,
    );

    // Polling loop: Wait → CHECK_STATUS → Choice
    waitForDeployment.next(checkDeploymentStatusTask);
    checkDeploymentStatusTask.next(evaluateDeploymentStatus);

    // Lambda failure path: AddLambdaErrorToContext → PUBLISH_RESULT
    addLambdaErrorToContext.next(publishDeploymentResultTask);

    // Create state machine
    this.stateMachine = new StateMachine(
      this,
      "BlueprintDeploymentStateMachine",
      {
        definitionBody: DefinitionBody.fromChainable(definition),
        stateMachineType: StateMachineType.STANDARD,
        timeout: Duration.minutes(stepFunctionTimeoutMinutes),
        tracingEnabled: true,
        logs: {
          destination: logGroup,
          level: LogLevel.ALL,
          includeExecutionData: true,
        },
      },
    );

    (this.stateMachine.node.defaultChild as any)?.addPropertyOverride("Tags", [
      {
        Key: "Component",
        Value: "BlueprintDeployment",
      },
      {
        Key: "ManagedBy",
        Value: "InnovationSandbox",
      },
    ]);

    // EventBridge rule to trigger Step Functions
    // Follows ISB event-driven pattern (same as CleanAccountRequest → Account Cleanup)
    new Rule(this, "BlueprintDeploymentRule", {
      eventBus,
      description:
        "EventBus rule that triggers blueprint deployment Step Functions workflow",
      targets: [new SfnStateMachine(this.stateMachine)],
      eventPattern: {
        detailType: [EventDetailTypes.BlueprintDeploymentRequest],
      },
    });
  }
}
