// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Construct } from "constructs";
import path from "node:path";

import { DeploymentUuidLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/deployment-uuid-lambda-environment.js";
import { IsbLambdaFunctionCustomResource } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function-custom-resource";

export interface DeploymentUuidProps {
  readonly namespace: string;
}

export class DeploymentUUID extends Construct {
  public readonly deploymentUUID: string;

  constructor(scope: Construct, id: string, props: DeploymentUuidProps) {
    super(scope, id);

    const deploymentUuidCR = new IsbLambdaFunctionCustomResource(
      this,
      "LambdaFunction",
      {
        description:
          "Custom resource lambda provider that generates a UUID on stack creation",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "custom-resources",
          "deployment-uuid",
          "src",
          "deployment-uuid-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        envSchema: DeploymentUuidLambdaEnvironmentSchema,
        environment: {},
        customResourceType: "Custom::DeploymentUUID",
      },
    );

    this.deploymentUUID = deploymentUuidCR.customResource
      .getAtt("DeploymentUUID")
      .toString();
  }
}
