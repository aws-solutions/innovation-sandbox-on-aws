// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Duration } from "aws-cdk-lib";
import {
  Application,
  ConfigurationContent,
  DeploymentStrategy,
  Environment,
  HostedConfiguration,
} from "aws-cdk-lib/aws-appconfig";
import { Construct } from "constructs";
import yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";

import { ValidatorExclusionConfigSchema } from "@amzn/innovation-sandbox-commons/data/validator-exclusion-config/validator-exclusion-config.js";
import { getSolutionContext } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";

export interface ConfigProps {
  namespace: string;
}

export class Config extends Construct {
  readonly application: Application;
  readonly environment: Environment;
  readonly deploymentStrategy: DeploymentStrategy;
  readonly nukeConfigHostedConfiguration: HostedConfiguration;
  readonly validatorExclusionConfigHostedConfiguration: HostedConfiguration;
  constructor(scope: Construct, id: string, props: ConfigProps) {
    super(scope, id);

    // Namespace only the account-global names (Application, DeploymentStrategy) so
    // multiple ISB instances coexist in one account. Environment and ConfigurationProfiles
    // are scoped to the Application, so they are left unnamed (naming them also makes the
    // AppConfig Deployment logical-id hash non-deterministic across synths).
    this.application = new Application(this, "Application", {
      applicationName: `${props.namespace}-Config-Application`,
      description: `AppConfig Application for Innovation Sandbox on AWS - ${props.namespace}`,
    });
    this.environment = new Environment(this, "Environment", {
      application: this.application,
      description: `AppConfig Environment for Innovation Sandbox on AWS - ${props.namespace}`,
    });

    this.deploymentStrategy = new DeploymentStrategy(
      this,
      "DeploymentStrategy",
      {
        deploymentStrategyName: `${props.namespace}-Config-DeploymentStrategy`,
        description: `AppConfig DeploymentStrategy for Innovation Sandbox on AWS - ${props.namespace}`,
        rolloutStrategy: {
          growthFactor: 100,
          deploymentDuration: Duration.minutes(0),
          finalBakeTime: Duration.minutes(0),
        },
      },
    );

    this.nukeConfigHostedConfiguration = new HostedConfiguration(
      this,
      "NukeConfigHostedConfiguration",
      {
        description: `NukeConfig AppConfig HostedConfiguration for Innovation Sandbox on AWS - ${props.namespace}`,
        application: this.application,
        deployTo: [this.environment],
        deploymentStrategy: this.deploymentStrategy,
        content: ConfigurationContent.fromFile(
          getSolutionContext(scope.node).nukeConfigFilePath ||
            path.join(__dirname, "nuke-config.yaml"),
          "application/x-yaml",
        ),
      },
    );

    const validatorExclusionConfigPath = path.join(
      __dirname,
      "validator-exclusion-config.yaml",
    );
    const validatorExclusionConfigContent = yaml.load(
      fs.readFileSync(validatorExclusionConfigPath, "utf-8"),
    );
    const parsedValidatorExclusionConfig =
      ValidatorExclusionConfigSchema.strict().safeParse(
        validatorExclusionConfigContent,
      );
    if (!parsedValidatorExclusionConfig.success) {
      const details = parsedValidatorExclusionConfig.error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");
      throw new Error(
        `validator-exclusion-config.yaml failed schema validation:\n${details}`,
      );
    }

    this.validatorExclusionConfigHostedConfiguration = new HostedConfiguration(
      this,
      "ValidatorExclusionConfigHostedConfiguration",
      {
        description: `ValidatorExclusionConfig AppConfig HostedConfiguration for Innovation Sandbox on AWS - ${props.namespace}`,
        application: this.application,
        deployTo: [this.environment],
        deploymentStrategy: this.deploymentStrategy,
        content: ConfigurationContent.fromFile(
          validatorExclusionConfigPath,
          "application/x-yaml",
        ),
      },
    );
  }
}
