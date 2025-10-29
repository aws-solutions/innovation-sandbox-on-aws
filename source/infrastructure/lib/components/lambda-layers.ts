// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack } from "aws-cdk-lib";
import {
  Architecture,
  Code,
  LayerVersion,
  Runtime,
} from "aws-cdk-lib/aws-lambda";
import { execSync } from "child_process";
import { Construct } from "constructs";
import { existsSync, mkdirSync, moveSync, rmSync } from "fs-extra";
import path from "path";

export class LambdaLayers extends Construct {
  readonly commonLayerVersion: LayerVersion;
  readonly dependencyLayerVersion: LayerVersion;
  readonly layers: LayerVersion[];
  private static instances: { [key: string]: LambdaLayers } = {};

  private constructor(scope: Construct, id: string) {
    super(scope, id);

    this.commonLayerVersion = new NodejsLayerVersion(
      this,
      "CommonLayerVersion",
      {
        path: path.join(__dirname, "..", "..", "..", "layers", "common"),
        description: "Common lib for Innovation Sandbox on AWS",
      },
    );

    this.dependencyLayerVersion = new NodejsLayerVersion(
      this,
      "DependenciesLayerVersion",
      {
        path: path.join(__dirname, "..", "..", "..", "layers", "dependencies"),
        description:
          "Third party runtime dependencies for Innovation Sandbox on AWS",
      },
    );

    this.layers = [this.dependencyLayerVersion, this.commonLayerVersion];
  }

  public static get(
    scope: Construct,
    layerId: string | undefined = undefined,
  ): LambdaLayers {
    const currentId = layerId ?? Stack.of(scope).stackName;
    if (!LambdaLayers.instances[currentId]) {
      LambdaLayers.instances[currentId] = new LambdaLayers(
        scope,
        `ISB-Lambda-Layer-${currentId}`,
      );
    }
    return LambdaLayers.instances[currentId]!;
  }
}

interface NodejsLayerVersionProps {
  path: string;
  description: string;
}

class NodejsLayerVersion extends LayerVersion {
  constructor(scope: Construct, id: string, props: NodejsLayerVersionProps) {
    //prettier-ignore
    execSync("npm ci --workspaces=false --install-links", { // NOSONAR typescript:S4036 - only used in cdk synth process
      cwd: props.path,
    });
    existsSync(path.join(props.path, "dist")) &&
      rmSync(path.join(props.path, "dist"), { recursive: true });
    mkdirSync(path.join(props.path, "dist/nodejs"), { recursive: true });
    moveSync(
      path.join(props.path, "node_modules"),
      path.join(props.path, "dist/nodejs/node_modules"),
    );
    super(scope, id, {
      code: Code.fromAsset(path.join(props.path, "dist")),
      description: props.description,
      compatibleRuntimes: [Runtime.NODEJS_22_X],
      compatibleArchitectures: [Architecture.ARM_64],
    });
  }
}
