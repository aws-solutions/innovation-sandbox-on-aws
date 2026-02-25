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
import { EventBus } from "aws-cdk-lib/aws-events";
import { Effect, Policy, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import fs from "fs";
import yaml from "js-yaml";
import path from "path";

import { InitializeCleanupLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/initialize-cleanup-lambda-environment.js";
import { AccountCleanerStepFunction } from "@amzn/innovation-sandbox-infrastructure/components/account-cleaner/step-function.js";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function.js";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms.js";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";

import { addAppConfigExtensionLayer } from "@amzn/innovation-sandbox-infrastructure/components/config/app-config-lambda-extension";
import { ConditionAspect } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-utils";
import {
  getIntermediateRoleName,
  getSandboxAccountRoleName,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  AppConfigReadPolicyStatement,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { Repository } from "aws-cdk-lib/aws-ecr";

const LAMBDA_TIMEOUT_SECONDS = 60;
const CODEBUILD_TIMEOUT_MINUTES = 60;
const STEPFUNCTION_TIMEOUT_MINUTES = 12 * 60;

interface AccountCleanerProps {
  eventBus: EventBus;
  namespace: string;
  orgMgtAccountId: string;
  idcAccountId: string;
  useStableTaggingCondition: CfnCondition;
}

export class AccountCleaner extends Construct {
  constructor(scope: Construct, id: string, props: AccountCleanerProps) {
    super(scope, id);
    const { eventBus } = props;

    const {
      configApplicationId,
      configEnvironmentId,
      nukeConfigConfigurationProfileId,
      globalConfigConfigurationProfileId,
      accountTable,
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
        {
          applicationId: configApplicationId,
          environmentId: configEnvironmentId,
          configurationProfileId: globalConfigConfigurationProfileId,
        },
      ],
    });

    const initializeCleanupLambda = new IsbLambdaFunction(
      this,
      "InitializeCleanupLambda",
      {
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "account-cleanup",
          "initialize-cleanup",
          "src",
          "initialize-cleanup-handler.ts",
        ),
        handler: "handler",
        timeout: Duration.seconds(LAMBDA_TIMEOUT_SECONDS),
        namespace: props.namespace,
        environment: {
          APP_CONFIG_APPLICATION_ID: configApplicationId,
          APP_CONFIG_ENVIRONMENT_ID: configEnvironmentId,
          APP_CONFIG_PROFILE_ID: globalConfigConfigurationProfileId,
          AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: `/applications/${configApplicationId}/environments/${configEnvironmentId}/configurations/${globalConfigConfigurationProfileId}`,
          ACCOUNT_TABLE_NAME: accountTable,
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          IDC_ACCOUNT_ID: props.idcAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
          CLEANUP_SPOKE_ROLE_NAME: sandboxAccountRoleName,
          INTERMEDIATE_ROLE_ARN: intermediateRoleArn,
        },
        envSchema: InitializeCleanupLambdaEnvironmentSchema,
        logGroup: IsbComputeResources.cleanupLogGroup,
      },
    );
    IntermediateRole.addTrustedRole(
      initializeCleanupLambda.lambdaFunction.role! as Role,
    );
    initializeCleanupLambda.lambdaFunction.addToRolePolicy(
      iamAppConfigPolicyStatement,
    );
    addAppConfigExtensionLayer(initializeCleanupLambda);

    grantIsbDbReadWrite(this, initializeCleanupLambda, accountTable);

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

    new AccountCleanerStepFunction(this, "StepFunction", {
      eventBus: eventBus,
      configApplicationId,
      configEnvironmentId,
      nukeConfigConfigurationProfileId,
      initializeCleanupLambda: initializeCleanupLambda.lambdaFunction,
      codeBuildCleanupProject: codeBuildCleanupProject,
      stepFunctionTimeOutInMinutes: STEPFUNCTION_TIMEOUT_MINUTES,
    });
  }
}
