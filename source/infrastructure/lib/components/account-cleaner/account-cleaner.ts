// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aspects, Aws, CfnCondition, Duration, Fn, Stack } from "aws-cdk-lib";
import {
  BuildEnvironmentVariableType,
  BuildSpec,
  CfnProject,
  LinuxBuildImage,
  Project,
} from "aws-cdk-lib/aws-codebuild";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaFunctionTarget } from "aws-cdk-lib/aws-events-targets";
import { Effect, Policy, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { Alias } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import fs from "fs";
import yaml from "js-yaml";
import path from "path";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { DurableCleanupLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/durable-cleanup-lambda-environment.js";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function.js";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms.js";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";

import { ConditionAspect } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import {
  getIdcRoleArn,
  getIntermediateRoleName,
  getOrgMgtRoleArn,
  getSandboxAccountRoleName,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  AppConfigReadPolicyStatement,
  grantIsbAppConfigRead,
  grantIsbDbReadOnly,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { Repository } from "aws-cdk-lib/aws-ecr";

const CODEBUILD_TIMEOUT_MINUTES = 60;

interface AccountCleanerProps {
  eventBus: EventBus;
  namespace: string;
  orgMgtAccountId: string;
  idcAccountId: string;
  useStableTaggingCondition: CfnCondition;
}

export class AccountCleaner extends Construct {
  public readonly durableCleanupFunctionArn: string;

  constructor(scope: Construct, id: string, props: AccountCleanerProps) {
    super(scope, id);
    const { eventBus } = props;

    const { idcConfigParamArn } =
      IsbComputeStack.sharedSpokeConfig.parameterArns;
    const {
      configApplicationId,
      configEnvironmentId,
      nukeConfigConfigurationProfileId,
      configTableName,
      validatorExclusionConfigConfigurationProfileId,
      accountTable,
      cleanupReportTable,
      principalTable,
      leaseTable,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const intermediateRoleName = getIntermediateRoleName(props.namespace);
    const intermediateRoleArn = Stack.of(this).formatArn({
      service: "iam",
      region: "",
      resource: "role",
      resourceName: intermediateRoleName,
    });
    const sandboxAccountRoleName = getSandboxAccountRoleName(props.namespace);

    const iamAppConfigPolicyStatement = new AppConfigReadPolicyStatement(this, {
      configurations: [
        {
          applicationId: configApplicationId,
          environmentId: configEnvironmentId,
          configurationProfileId: nukeConfigConfigurationProfileId,
        },
      ],
    });

    const usePrivateEcr = new CfnCondition(this, "UsePrivateEcrRepo", {
      expression: Fn.conditionNot(
        Fn.conditionEquals(getContextFromMapping(this, "privateEcrRepo"), ""),
      ),
    });

    const fullVersionImageTag = getContextFromMapping(this, "publicEcrTag");
    const versionParts = Fn.split(".", fullVersionImageTag);
    const stableVersionImageTag = Fn.join(".", [
      Fn.select(0, versionParts),
      Fn.select(1, versionParts),
    ]);
    const imageTag = Fn.conditionIf(
      props.useStableTaggingCondition.logicalId,
      stableVersionImageTag, // vX.X
      fullVersionImageTag, // vX.X.X
    ).toString();
    const publicImage = LinuxBuildImage.fromDockerRegistry(
      `${getContextFromMapping(this, "publicEcrRegistry")}/${getContextFromMapping(this, "solutionName")}-account-cleaner:${imageTag}`,
    );

    const privateImage = LinuxBuildImage.fromEcrRepository(
      Repository.fromRepositoryName(
        this,
        "EcrRepo",
        getContextFromMapping(this, "privateEcrRepo"),
      ),
      "latest",
    );

    // CodeBuild resources
    const codeBuildCleanupProject = new Project(
      this,
      "CodeBuildCleanupProject",
      {
        timeout: Duration.minutes(CODEBUILD_TIMEOUT_MINUTES),
        buildSpec: BuildSpec.fromObjectToYaml(
          yaml.load(
            fs.readFileSync(
              path.join(__dirname, "cleanup-buildspec.yaml"),
              "utf8",
            ),
          ) as {
            [key: string]: any;
          },
        ),
        environment: {
          buildImage: publicImage,
          environmentVariables: {
            HUB_ACCOUNT_ID: {
              value: Stack.of(this).account,
              type: BuildEnvironmentVariableType.PLAINTEXT,
            },
            INTERMEDIATE_ROLE_ARN: {
              value: intermediateRoleArn,
              type: BuildEnvironmentVariableType.PLAINTEXT,
            },
            CLEANUP_ROLE_NAME: {
              value: sandboxAccountRoleName,
              type: BuildEnvironmentVariableType.PLAINTEXT,
            },
            ACCOUNT_POOL_CONFIG_PARAM_ARN: {
              value:
                IsbComputeStack.sharedSpokeConfig.parameterArns
                  .accountPoolConfigParamArn,
              type: BuildEnvironmentVariableType.PLAINTEXT,
            },
          },
        },
        logging: {
          cloudWatch: {
            logGroup: IsbComputeResources.cleanupLogGroup,
          },
        },
        encryptionKey: IsbKmsKeys.get(this, props.namespace),
      },
    );

    // Conditionally add private image if provided
    const cfnProject = codeBuildCleanupProject.node.defaultChild as CfnProject;
    cfnProject.addPropertyOverride(
      "Environment.Image",
      Fn.conditionIf(
        usePrivateEcr.logicalId,
        privateImage.imageId,
        publicImage.imageId,
      ).toString(),
    );

    // Conditionally add necessary permissions for private image if provided
    const privateEcrRepoPolicy = new Policy(this, "PrivateEcrRepoPolicy", {
      roles: [codeBuildCleanupProject.role!],
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
          ],
          resources: [privateImage.repository?.repositoryArn!],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["ecr:GetAuthorizationToken"],
          resources: ["*"],
        }),
      ],
    });
    Aspects.of(privateEcrRepoPolicy).add(new ConditionAspect(usePrivateEcr));

    grantIsbSsmParameterRead(
      codeBuildCleanupProject.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );
    codeBuildCleanupProject.addToRolePolicy(iamAppConfigPolicyStatement);
    IntermediateRole.addTrustedRole(codeBuildCleanupProject.role! as Role);

    // === Durable Function Cleanup Orchestration ===

    const durableCleanupLambda = new IsbLambdaFunction(
      this,
      "DurableCleanupOrchestrationLambda",
      {
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "account-cleanup",
          "durable-cleanup-orchestration",
          "src",
          "durable-cleanup-handler.ts",
        ),
        handler: "handler",
        bundling: {
          commandHooks: {
            beforeBundling: () => [],
            beforeInstall: () => [],
            afterBundling: (inputDir: string, outputDir: string) => [
              `cp ${inputDir}/source/lambdas/account-cleanup/durable-cleanup-orchestration/src/validator-exclusion-config.isb-overlay.yaml ${outputDir}`,
            ],
          },
        },
        // Per-invocation timeout (not total execution time). Needs headroom for
        // Resource Explorer enumeration across regions and durable replay overhead.
        timeout: Duration.minutes(5),
        namespace: props.namespace,
        durableConfig: {
          // Platform max (1 year). Must exceed the 360-day cooldown cap
          // (MAX_COOLDOWN_PERIOD_HOURS) since the cooldown waits inside this run.
          executionTimeout: Duration.days(365),
          retentionPeriod: Duration.days(30),
        },
        environment: {
          APP_CONFIG_APPLICATION_ID: configApplicationId,
          APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
          CONFIG_TABLE_NAME: configTableName,
          ACCOUNT_TABLE_NAME: accountTable,
          LEASE_TABLE_NAME: leaseTable,
          PRINCIPAL_TABLE_NAME: principalTable,
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          IDC_ACCOUNT_ID: props.idcAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
          CLEANUP_SPOKE_ROLE_NAME: sandboxAccountRoleName,
          INTERMEDIATE_ROLE_ARN: intermediateRoleArn,
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            this,
            props.namespace,
            props.orgMgtAccountId,
          ),
          IDC_CONFIG_PARAM_ARN: idcConfigParamArn,
          IDC_ROLE_ARN: getIdcRoleArn(
            this,
            props.namespace,
            props.idcAccountId,
          ),
          ISB_EVENT_BUS: eventBus.eventBusName,
          ISB_NAMESPACE: props.namespace,
          CODEBUILD_PROJECT_NAME: codeBuildCleanupProject.projectName,
          APPCONFIG_NUKE_CONFIG_CONFIGURATION_PROFILE_ID:
            nukeConfigConfigurationProfileId,
          CLEANUP_REPORT_TABLE_NAME: cleanupReportTable,
          ACCOUNT_POOL_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns
              .accountPoolConfigParamArn,
          APPCONFIG_VALIDATOR_EXCLUSION_CONFIG_PROFILE_ID:
            validatorExclusionConfigConfigurationProfileId,
          CODEBUILD_TIMEOUT_MINUTES: CODEBUILD_TIMEOUT_MINUTES.toString(),
        },
        envSchema: DurableCleanupLambdaEnvironmentSchema,
        logGroup: IsbComputeResources.cleanupLogGroup,
      },
    );

    // Durable execution IAM permissions
    durableCleanupLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "lambda:CheckpointDurableExecution",
          "lambda:GetDurableExecutionState",
        ],
        resources: ["*"],
      }),
    );
    durableCleanupLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
        resources: [codeBuildCleanupProject.projectArn],
      }),
    );
    eventBus.grantPutEventsTo(durableCleanupLambda.lambdaFunction);
    grantIsbDbReadOnly(this, durableCleanupLambda, configTableName);
    grantIsbAppConfigRead(
      this,
      durableCleanupLambda,
      validatorExclusionConfigConfigurationProfileId,
    );
    IntermediateRole.addTrustedRole(
      durableCleanupLambda.lambdaFunction.role! as Role,
    );
    grantIsbDbReadWrite(
      this,
      durableCleanupLambda,
      accountTable,
      cleanupReportTable,
      principalTable,
      leaseTable,
    );
    grantIsbSsmParameterRead(
      durableCleanupLambda.lambdaFunction.role! as Role,
      idcConfigParamArn,
    );
    grantIsbSsmParameterRead(
      durableCleanupLambda.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );

    // Create the `live` alias required for durable execution invocation
    const durableCleanupAlias = new Alias(this, "DurableCleanupAlias", {
      aliasName: "live",
      version: durableCleanupLambda.lambdaFunction.currentVersion,
    });

    // Callback Relay Lambda — intercepts CodeBuild Build State Change events from
    // the default event bus and forwards them to the durable cleanup Lambda via the
    // Lambda Durable Execution callback API, enabling wait-for-callback suspension during
    // Nuke builds.
    const callbackRelayLambda = new IsbLambdaFunction(
      this,
      "CallbackRelayLambda",
      {
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "account-cleanup",
          "callback-relay",
          "src",
          "callback-relay-handler.ts",
        ),
        handler: "handler",
        timeout: Duration.seconds(30),
        namespace: props.namespace,
        // Bundle @aws-sdk/client-lambda — the durable callback commands
        // are not in the Lambda runtime's built-in SDK version yet.
        bundling: {
          externalModules: [],
        },
        environment: {},
        envSchema: BaseLambdaEnvironmentSchema,
        logGroup: IsbComputeResources.cleanupLogGroup,
      },
    );

    callbackRelayLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["codebuild:BatchGetBuilds"],
        resources: [codeBuildCleanupProject.projectArn],
      }),
    );
    this.durableCleanupFunctionArn =
      durableCleanupLambda.lambdaFunction.functionArn;

    callbackRelayLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "lambda:SendDurableExecutionCallbackSuccess",
          "lambda:SendDurableExecutionCallbackFailure",
        ],
        resources: [
          `${durableCleanupLambda.lambdaFunction.functionArn}:*/durable-execution/*`,
        ],
      }),
    );

    // EventBridge rule: CodeBuild terminal statuses → Callback Relay
    new Rule(this, "CodeBuildStateChangeRule", {
      eventPattern: {
        source: ["aws.codebuild"],
        detailType: ["CodeBuild Build State Change"],
        detail: {
          "project-name": [codeBuildCleanupProject.projectName],
          "build-status": [
            "SUCCEEDED",
            "FAILED",
            "FAULT",
            "STOPPED",
            "TIMED_OUT",
          ],
        },
      },
      targets: [new LambdaFunctionTarget(callbackRelayLambda.lambdaFunction)],
    });

    // EventBridge rule: CleanAccountRequest → Durable Function alias
    new Rule(this, "DurableCleanupRule", {
      eventBus: eventBus,
      eventPattern: {
        detailType: ["CleanAccountRequest"],
      },
      targets: [
        new LambdaFunctionTarget(durableCleanupAlias, {
          retryAttempts: 5,
        }),
      ],
    });
  }
}
