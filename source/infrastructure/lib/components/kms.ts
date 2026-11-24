// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { RemovalPolicy, Stack } from "aws-cdk-lib";
import { Key } from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

import { isDevMode } from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";

export class IsbKmsKeys {
  private static readonly instances: { [key: string]: Key } = {};
  public static get(
    scope: Construct,
    namespace: string,
    keyId: string | undefined = undefined,
  ): Key {
    const isbKeyId = keyId ?? Stack.of(scope).stackName;
    IsbKmsKeys.instances[isbKeyId] ??= new Key(
      Stack.of(scope),
      `IsbKmsKey-${isbKeyId}`,
      {
        enableKeyRotation: true,
        description: `Encryption Key for Innovation Sandbox: ${isbKeyId}`,
        alias: `AwsSolutions/InnovationSandbox/${namespace}/${isbKeyId}`,
        removalPolicy: isDevMode(scope)
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN,
      },
    );
    return IsbKmsKeys.instances[isbKeyId];
  }
}
