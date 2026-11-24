// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Aws, Duration } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  MathExpression,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { Role } from "aws-cdk-lib/aws-iam";
import {
  Choice,
  Condition,
  DefinitionBody,
  Fail,
  IChainable,
  JsonPath,
  LogLevel,
  Pass,
  StateMachine,
  StateMachineType,
  Succeed,
  TaskInput,
  Wait,
  WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { Construct } from "constructs";
import path from "node:path";

import { TagActivationCheckerEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/tag-activation-checker-environment";
import { TagActivationTriggerEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/tag-activation-trigger-environment";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbLambdaFunctionCustomResource } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function-custom-resource";
import { IsbLogGroups } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-groups";
import {
  getOrgMgtRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";

export interface TagActivationWorkflowProps {
  readonly namespace: string;
  readonly orgMgtAccountId: string;
  readonly maxAttempts?: number;
}

/**
 * Step Functions workflow that seeds the hub account with the ISB cost allocation
 * tag keys and polls Cost Explorer until all 5 keys report `Active`.
 *
 * Placement: the compute stack (hub account). The checker Lambda assumes
 * `OrgMgtRole` via `IntermediateRole` to call Cost Explorer and Organizations
 * APIs in the org management account — same pattern as every other
 * operational ISB Lambda. Execution history, state machine logs, and the
 * `ExecutionFailedAlarm` land in the hub account where operators look.
 *
 * The alarm fires on any terminal non-success outcome of the state machine
 * that is not operator-initiated: `ExecutionsFailed` (unhandled Lambda error
 * or the `TagActivationMaxAttemptsReached` Fail state) and
 * `ExecutionsTimedOut` (the state machine's own timeout expired before the
 * loop could terminate). Both indicate tag activation did not complete.
 * Slow activation inside the polling loop does not
 * trip the alarm either — billing tag propagation is inherently delayed and
 * is handled by the attempt counter, not by failing the execution.
 */
export class TagActivationWorkflow extends Construct {
  public readonly stateMachine: StateMachine;
  public readonly executionFailedAlarm: Alarm;

  constructor(scope: Construct, id: string, props: TagActivationWorkflowProps) {
    super(scope, id);

    const maxAttempts = props.maxAttempts ?? 24;
    const customResourceLogGroup = IsbLogGroups.customResourceLogGroup(
      this,
      props.namespace,
    );

    const checkerLambda = new IsbLambdaFunction(this, "TagActivationChecker", {
      description:
        "Seeds ISB cost allocation tag keys on the hub account and polls Cost Explorer until the keys are Active.",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "custom-resources",
        "tag-activation-checker",
        "src",
        "tag-activation-checker-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      envSchema: TagActivationCheckerEnvironmentSchema,
      environment: {
        ISB_NAMESPACE: props.namespace,
        HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
          this,
          props.namespace,
          props.orgMgtAccountId,
        ),
      },
      timeout: Duration.minutes(5),
      logGroup: customResourceLogGroup,
    });

    IntermediateRole.addTrustedRole(checkerLambda.lambdaFunction.role! as Role);

    const normalizeInput = new Pass(this, "NormalizeInput", {
      parameters: {
        hubAccountId: Aws.ACCOUNT_ID,
        maxAttempts,
        attempt: 0,
      },
    });

    // Phase 1: SEED — tag the hub account with temporary ISB-<namespace>:* tags
    // so the keys propagate into the billing system.
    const seedTask = new LambdaInvoke(this, "SeedTagsTask", {
      lambdaFunction: checkerLambda.lambdaFunction,
      payload: TaskInput.fromObject({
        phase: "SEED",
        "hubAccountId.$": "$.hubAccountId",
      }),
      resultPath: JsonPath.DISCARD,
    });

    // Phase 2: CHECK — list + activate ISB cost allocation tag status.
    const checkTask = new LambdaInvoke(this, "CheckTagsTask", {
      lambdaFunction: checkerLambda.lambdaFunction,
      payload: TaskInput.fromObject({
        phase: "CHECK",
        "hubAccountId.$": "$.hubAccountId",
        "maxAttempts.$": "$.maxAttempts",
        "attempt.$": "$.attempt",
      }),
      resultPath: "$.checkResult",
      resultSelector: {
        "completed.$": "$.Payload.completed",
      },
    });

    const incrementAttempt = new Pass(this, "IncrementAttempt", {
      parameters: {
        "hubAccountId.$": "$.hubAccountId",
        "maxAttempts.$": "$.maxAttempts",
        "checkResult.$": "$.checkResult",
        attempt: JsonPath.mathAdd(JsonPath.numberAt("$.attempt"), 1),
      },
    });

    const waitBeforeNextCheck = new Wait(this, "WaitBeforeNextCheck", {
      time: WaitTime.duration(Duration.hours(1)),
    });

    const succeed = new Succeed(this, "TagActivationSucceeded");

    const maxAttemptsReached = new Fail(
      this,
      "TagActivationMaxAttemptsReached",
      {
        cause:
          "Tag activation did not complete within the allowed attempts. ISB cost allocation tags may still be inactive in the billing console; manual activation via the Cost Allocation Tags page is the documented fallback.",
        error: "TagActivationMaxAttemptsReached",
      },
    );

    // Single decision point evaluated after every CHECK + increment:
    //   1. completed → Succeed
    //   2. attempt counter hit maxAttempts → Fail
    //   3. otherwise → wait an hour and check again
    // IncrementAttempt runs on every iteration (including the completion
    // path) so `$.attempt` and `$.checkResult` are both live here. One extra
    // no-op hop on the happy path in exchange for a single, easy-to-read
    // decision point.
    const evaluateCheckResult = new Choice(this, "EvaluateCheckResult")
      .when(Condition.booleanEquals("$.checkResult.completed", true), succeed)
      .when(
        Condition.numberGreaterThanEqualsJsonPath("$.attempt", "$.maxAttempts"),
        maxAttemptsReached,
      )
      .otherwise(waitBeforeNextCheck.next(checkTask));

    const definition: IChainable = normalizeInput
      .next(seedTask)
      .next(checkTask)
      .next(incrementAttempt)
      .next(evaluateCheckResult);

    this.stateMachine = new StateMachine(this, "StateMachine", {
      definitionBody: DefinitionBody.fromChainable(definition),
      stateMachineType: StateMachineType.STANDARD,
      tracingEnabled: true,
      logs: {
        level: LogLevel.ALL,
        destination: customResourceLogGroup,
        includeExecutionData: true,
      },
      timeout: Duration.hours(maxAttempts + 1), // N attempts @ 1h + 1h buffer
    });

    this.executionFailedAlarm = new Alarm(this, "ExecutionFailedAlarm", {
      alarmDescription:
        "Tag activation Step Functions workflow did not complete successfully (Failed or TimedOut). Cost allocation tags may not be active in the billing console; queries relying on ISB-<namespace>:* tag grouping will fall back to the legacy LINKED_ACCOUNT path. Investigate via CloudWatch Logs for the TagActivationChecker Lambda.",
      metric: new MathExpression({
        expression: "failed + timedOut",
        usingMetrics: {
          failed: this.stateMachine.metricFailed({
            period: Duration.hours(1),
            statistic: "Sum",
          }),
          timedOut: this.stateMachine.metricTimedOut({
            period: Duration.hours(1),
            statistic: "Sum",
          }),
        },
        period: Duration.hours(1),
        label: "TerminalNonSuccessExecutions",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const triggerCR = new IsbLambdaFunctionCustomResource(
      this,
      "TagActivationTrigger",
      {
        description:
          "Custom resource that starts the tag activation workflow on stack create/update and deactivates ISB cost allocation tags on stack delete.",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "custom-resources",
          "tag-activation-trigger",
          "src",
          "tag-activation-trigger-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        envSchema: TagActivationTriggerEnvironmentSchema,
        environment: {
          ISB_NAMESPACE: props.namespace,
          STATE_MACHINE_ARN: this.stateMachine.stateMachineArn,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            this,
            props.namespace,
            props.orgMgtAccountId,
          ),
        },
        customResourceType: "Custom::TagActivationTrigger",
        customResourceProperties: {
          forceUpdate: Date.now(),
        },
      },
    );

    this.stateMachine.grantStartExecution(triggerCR.lambdaFunction);

    IntermediateRole.addTrustedRole(triggerCR.lambdaFunction.role! as Role);
  }
}
