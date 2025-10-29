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
import path from "path";

import { getSolutionContext } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";

export interface ConfigProps {
  namespace: string;
}

export class Config extends Construct {
  readonly application: Application;
  readonly environment: Environment;
  readonly deploymentStrategy: DeploymentStrategy;
  readonly globalConfigHostedConfiguration: HostedConfiguration;
  readonly nukeConfigHostedConfiguration: HostedConfiguration;
  readonly reportingConfigHostedConfiguration: HostedConfiguration;
  constructor(scope: Construct, id: string, props: ConfigProps) {
    super(scope, id);

    this.application = new Application(this, "Application", {
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
        description: `AppConfig DeploymentStrategy for Innovation Sandbox on AWS - ${props.namespace}`,
        rolloutStrategy: {
          growthFactor: 100,
          deploymentDuration: Duration.minutes(0),
          finalBakeTime: Duration.minutes(0),
        },
      },
    );

    this.globalConfigHostedConfiguration = new HostedConfiguration(
      this,
      "GlobalConfigHostedConfiguration",
      {
        description: `GlobalConfig AppConfig HostedConfiguration for Innovation Sandbox on AWS - ${props.namespace}`,
        application: this.application,
        deployTo: [this.environment],
        deploymentStrategy: this.deploymentStrategy,
        content: ConfigurationContent.fromFile(
          path.join(__dirname, "global-config.yaml"),
          "application/x-yaml",
        ),
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

    this.reportingConfigHostedConfiguration = new HostedConfiguration(
      this,
      "ReportingConfigHostedConfiguration",
      {
        description: `ReportingConfig AppConfig HostedConfiguration for Innovation Sandbox on AWS - ${props.namespace}`,
        application: this.application,
        deployTo: [this.environment],
        deploymentStrategy: this.deploymentStrategy,
        content: ConfigurationContent.fromFile(
          path.join(__dirname, "reporting-config.yaml"),
          "application/x-yaml",
        ),
      },
    );
  }
}
