// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Project } from "aws-cdk-lib/aws-codebuild";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { SfnStateMachine } from "aws-cdk-lib/aws-events-targets";
import {
  Chain,
  Choice,
  Condition,
  CustomState,
  DefinitionBody,
  Fail,
  JsonPath,
  LogLevel,
  Pass,
  StateMachine,
  Succeed,
  TaskInput,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  EventBridgePutEvents,
  LambdaInvoke,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { ArnFormat, Duration, Stack } from "aws-cdk-lib/core";
import { Construct } from "constructs";

import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources.js";
import { Effect, Policy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Function } from "aws-cdk-lib/aws-lambda";

interface AccountCleanerStepFunctionProps {
  configApplicationId: string;
  configEnvironmentId: string;
  nukeConfigConfigurationProfileId: string;
  initializeCleanupLambda: Function;
  codeBuildCleanupProject: Project;
  eventBus: EventBus;
  stepFunctionTimeOutInMinutes: number;
}

export class AccountCleanerStepFunction extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: AccountCleanerStepFunctionProps,
  ) {
    super(scope, id);

    const {
      configApplicationId,
      configEnvironmentId,
      nukeConfigConfigurationProfileId,
      initializeCleanupLambda,
      codeBuildCleanupProject,
      eventBus,
      stepFunctionTimeOutInMinutes,
    } = props;

    const addCodeBuildExecutionResultsObjectPass = new Pass(
      this,
      "AddCodeBuildExecutionResultsObjectPass",
      {
        parameters: {
          input: JsonPath.objectAt("$.detail"),
          executionResults: {
            succeeded: 0,
            failed: 0,
          },
        },
      },
    );

    const initializeCleanupLambdaInvoke = new LambdaInvoke(
      this,
      "InitializeCleanupLambdaInvoke",
      {
        lambdaFunction: initializeCleanupLambda,
        payload: TaskInput.fromObject({
          accountId: JsonPath.stringAt("$.input.accountId"),
          cleanupExecutionContext: {
            stateMachineExecutionArn: JsonPath.executionId,
            stateMachineExecutionStartTime: JsonPath.executionStartTime,
          },
        }),
        resultSelector: {
          payload: JsonPath.stringAt("$.Payload"),
          status: JsonPath.stringAt("$.StatusCode"),
        },
        resultPath: JsonPath.stringAt("$.initializeCleanup"),
      },
    );

    // Using CustomState construct due to missing log config override capabilities of CodeBuildStartBuild
    const startCodeBuildCall = new CustomState(this, "StartCodeBuildCall", {
      stateJson: {
        Type: "Task",
        Resource: "arn:aws:states:::codebuild:startBuild.sync",
        Parameters: {
          ProjectName: codeBuildCleanupProject.projectName,
          EnvironmentVariablesOverride: [
            {
              Name: "STATE_MACHINE_EXECUTION_ID",
              "Value.$": JsonPath.executionId,
              Type: "PLAINTEXT",
            },
            {
              Name: "CLEANUP_ACCOUNT_ID",
              "Value.$": JsonPath.stringAt("$.input.accountId"),
              Type: "PLAINTEXT",
            },
            {
              Name: "APPCONFIG_APPLICATION_ID",
              Value: configApplicationId,
              Type: "PLAINTEXT",
            },
            {
              Name: "APPCONFIG_ENVIRONMENT_ID",
              Value: configEnvironmentId,
              Type: "PLAINTEXT",
            },
            {
              Name: "APPCONFIG_NUKE_CONFIG_CONFIGURATION_PROFILE_ID",
              Value: nukeConfigConfigurationProfileId,
              Type: "PLAINTEXT",
            },
          ],
          LogsConfigOverride: {
            CloudWatchLogs: {
              Status: "ENABLED",
              GroupName: IsbComputeResources.cleanupLogGroup.logGroupName,
              "StreamName.$": JsonPath.arrayGetItem(
                JsonPath.stringSplit(JsonPath.executionId, ":"),
                7,
              ),
            },
          },
        },
        ResultSelector: {
          "status.$": JsonPath.stringAt("$.Build.BuildStatus"),
        },
        ResultPath: JsonPath.stringAt("$.codeBuild"),
      },
    });

    const addSuccessfulExecutionPass = new Pass(
      this,
      "AddSuccessfulExecutionPass",
      {
        parameters: {
          input: JsonPath.objectAt("$.input"),
          initializeCleanup: JsonPath.objectAt("$.initializeCleanup"),
          executionResults: {
            succeeded: JsonPath.mathAdd(
              JsonPath.numberAt("$.executionResults.succeeded"),
              1,
            ),
            failed: JsonPath.numberAt("$.executionResults.failed"),
          },
        },
      },
    );

    const addFailedExecutionPass = new Pass(this, "AddFailedExecutionPass", {
      parameters: {
        input: JsonPath.objectAt("$.input"),
        initializeCleanup: JsonPath.objectAt("$.initializeCleanup"),
        executionResults: {
          succeeded: 0,
          failed: JsonPath.mathAdd(
            JsonPath.numberAt("$.executionResults.failed"),
            1,
          ),
        },
      },
    });

    const successRerunWait = new Wait(this, "SuccessRerunWait", {
      time: WaitTime.secondsPath(
        "$.initializeCleanup.payload.globalConfig.cleanup.waitBeforeRerunSuccessfulAttemptSeconds",
      ),
    });

    const failureRerunWait = new Wait(this, "FailureRerunWait", {
      time: WaitTime.secondsPath(
        "$.initializeCleanup.payload.globalConfig.cleanup.waitBeforeRetryFailedAttemptSeconds",
      ),
    });

    const putSuccessEvent = new EventBridgePutEvents(this, "SendSuccessEvent", {
      entries: [
        {
          eventBus: eventBus,
          source: "account-cleaner",
          detailType: EventDetailTypes.AccountCleanupSuccessful,
          detail: TaskInput.fromObject({
            accountId: JsonPath.stringAt("$.input.accountId"),
            cleanupExecutionContext: {
              stateMachineExecutionArn: JsonPath.executionId,
              stateMachineExecutionStartTime: JsonPath.executionStartTime,
            },
            reason: JsonPath.stringAt("$.input.reason"),
          }),
        },
      ],
    });

    const putFailureEvent = new EventBridgePutEvents(this, "SendFailureEvent", {
      entries: [
        {
          eventBus: eventBus,
          source: "account-cleaner",
          detailType: EventDetailTypes.AccountCleanupFailure,
          detail: TaskInput.fromObject({
            accountId: JsonPath.stringAt("$.input.accountId"),
            cleanupExecutionContext: {
              stateMachineExecutionArn: JsonPath.executionId,
              stateMachineExecutionStartTime: JsonPath.executionStartTime,
            },
            reason: JsonPath.stringAt("$.input.reason"),
          }),
        },
      ],
    });

    const stepFunctionSucceed = new Succeed(this, "AccountCleanupSuccess");

    const stepFunctionFailed = new Fail(this, "AccountCleanupFailed");

    initializeCleanupLambdaInvoke.addCatch(putFailureEvent, {
      errors: ["States.ALL"],
      resultPath: "$.Error",
    });

    const cleanupAlreadyInProgressCondition = Condition.booleanEquals(
      "$.initializeCleanup.payload.cleanupAlreadyInProgress",
      true,
    );

    const skipIfCurrentlyInCleanupChoice = new Choice(
      this,
      "SkipIfCurrentlyInCleanupChoice",
    );

    const enoughFailedExecutionsCondition = Condition.numberLessThanJsonPath(
      "$.executionResults.failed",
      "$.initializeCleanup.payload.globalConfig.cleanup.numberOfFailedAttemptsToCancelCleanup",
    );
    const enoughFailedExecutionsChoice = new Choice(
      this,
      "EnoughFailedExecutionsChoice",
    );

    const enoughSuccessfulExecutionsCondition =
      Condition.numberGreaterThanEqualsJsonPath(
        "$.executionResults.succeeded",
        "$.initializeCleanup.payload.globalConfig.cleanup.numberOfSuccessfulAttemptsToFinishCleanup",
      );
    const enoughSuccessfulExecutionsChoice = new Choice(
      this,
      "EnoughSuccessfulExecutionsChoice",
    );

    startCodeBuildCall.addCatch(
      addFailedExecutionPass.next(
        enoughFailedExecutionsChoice
          .when(
            enoughFailedExecutionsCondition,
            failureRerunWait.next(startCodeBuildCall),
          )
          .otherwise(putFailureEvent.next(stepFunctionFailed)),
      ),
      {
        errors: ["States.ALL"],
        resultPath: "$.Error",
      },
    );

    const stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(
        Chain.start(addCodeBuildExecutionResultsObjectPass)
          .next(initializeCleanupLambdaInvoke)
          .next(
            skipIfCurrentlyInCleanupChoice
              .when(cleanupAlreadyInProgressCondition, stepFunctionSucceed)
              .otherwise(
                startCodeBuildCall
                  .next(addSuccessfulExecutionPass)
                  .next(
                    enoughSuccessfulExecutionsChoice
                      .when(
                        enoughSuccessfulExecutionsCondition,
                        putSuccessEvent.next(stepFunctionSucceed),
                      )
                      .otherwise(successRerunWait.next(startCodeBuildCall)),
                  ),
              ),
          ),
      ),
      timeout: Duration.minutes(stepFunctionTimeOutInMinutes),
      logs: {
        level: LogLevel.ALL,
        destination: IsbComputeResources.globalLogGroup,
      },
      tracingEnabled: true,
    });

    new Policy(this, "CodeBuildStepPolicy", {
      roles: [stateMachine.role],
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "codebuild:StartBuild",
            "codebuild:StopBuild",
            "codebuild:BatchGetBuilds",
            "codebuild:BatchGetReports",
          ],
          resources: [codeBuildCleanupProject.projectArn],
        }),
        new PolicyStatement({
          // This is used by the state machine step for listening to completion of codebuild run
          effect: Effect.ALLOW,
          actions: [
            "events:PutTargets",
            "events:PutRule",
            "events:DescribeRule",
          ],
          resources: [
            Stack.of(this).formatArn({
              service: "events",
              resource: "rule",
              resourceName: "StepFunctionsGetEventForCodeBuildStartBuildRule",
            }),
          ],
        }),
      ],
    });

    new Policy(this, "DescribeStateMachineExecutionPolicy", {
      roles: [initializeCleanupLambda.role!],
      statements: [
        new PolicyStatement({
          actions: ["states:DescribeExecution"],
          resources: [
            Stack.of(this).formatArn({
              service: "states",
              resource: "execution",
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
              resourceName: `${stateMachine.stateMachineName}:*`,
            }),
          ],
        }),
      ],
    });

    new Rule(this, "AccountCleanupRule", {
      eventBus,
      description:
        "EventBus rule that triggers the ISB account cleanup process",
      targets: [new SfnStateMachine(stateMachine)],
      eventPattern: {
        detailType: [EventDetailTypes.CleanAccountRequest],
      },
    });
  }
}
