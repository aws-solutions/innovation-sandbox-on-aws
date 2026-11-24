// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import { isDevMode } from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";
import { RemovalPolicy, Stack, Token } from "aws-cdk-lib";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export class IsbLogGroups {
  private static logGroups: { [key: string]: LogGroup } = {};
  public static globalLogGroup(scope: Construct, namespace: string): LogGroup {
    const stack = Stack.of(scope);
    const logGroupId = `${stack.stackName}-ISBLogGroup`;
    if (!IsbLogGroups.logGroups[logGroupId]) {
      const logGroup = new LogGroup(stack, "ISBLogGroup", {
        encryptionKey: IsbKmsKeys.get(scope, namespace),
        removalPolicy: isDevMode(scope)
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN,
        retention: Token.asNumber(
          getContextFromMapping(scope, "cloudWatchLogRetentionInDays"),
        ),
      });
      IsbLogGroups.logGroups[logGroupId] = logGroup;
      addCfnGuardSuppression(logGroup, ["CW_LOGGROUP_RETENTION_PERIOD_CHECK"]); // Retention period is defined in CfnMapping and evades the CFN Guard check
    }
    return IsbLogGroups.logGroups[logGroupId];
  }

  public static cleanupLogGroup(scope: Construct, namespace: string): LogGroup {
    const stack = Stack.of(scope);
    const logGroupId = `${stack.stackName}-ISBLogGroup-Cleanup`;
    if (!IsbLogGroups.logGroups[logGroupId]) {
      const logGroup = new LogGroup(stack, "ISBLogGroup-Cleanup", {
        encryptionKey: IsbKmsKeys.get(scope, namespace),
        removalPolicy: isDevMode(scope)
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN,
        retention: Token.asNumber(
          getContextFromMapping(scope, "cloudWatchLogRetentionInDays"),
        ),
      });
      IsbLogGroups.logGroups[logGroupId] = logGroup;
      addCfnGuardSuppression(logGroup, ["CW_LOGGROUP_RETENTION_PERIOD_CHECK"]); // Retention period is defined in CfnMapping and evades the CFN Guard check
    }
    return IsbLogGroups.logGroups[logGroupId];
  }

  public static authLogGroup(scope: Construct, namespace: string): LogGroup {
    const stack = Stack.of(scope);
    const logGroupId = `${stack.stackName}-ISBLogGroup-Auth`;
    if (!IsbLogGroups.logGroups[logGroupId]) {
      const logGroup = new LogGroup(stack, "ISBLogGroup-Auth", {
        encryptionKey: IsbKmsKeys.get(scope, namespace),
        removalPolicy: isDevMode(scope)
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN,
        retention: Token.asNumber(
          getContextFromMapping(scope, "cloudWatchLogRetentionInDays"),
        ),
      });
      IsbLogGroups.logGroups[logGroupId] = logGroup;
      addCfnGuardSuppression(logGroup, ["CW_LOGGROUP_RETENTION_PERIOD_CHECK"]); // Retention period is defined in CfnMapping and evades the CFN Guard check
    }
    return IsbLogGroups.logGroups[logGroupId];
  }

  public static customResourceLogGroup(
    scope: Construct,
    namespace: string,
  ): LogGroup {
    const stack = Stack.of(scope);
    const logGroupId = `${stack.stackName}-ISBLogGroup-CustomResources`;
    if (!IsbLogGroups.logGroups[logGroupId]) {
      const logGroup = new LogGroup(stack, "ISBLogGroup-CustomResources", {
        encryptionKey: IsbKmsKeys.get(scope, namespace),
        removalPolicy: isDevMode(scope)
          ? RemovalPolicy.DESTROY
          : RemovalPolicy.RETAIN,
        retention: Token.asNumber(
          getContextFromMapping(scope, "cloudWatchLogRetentionInDays"),
        ),
      });
      IsbLogGroups.logGroups[logGroupId] = logGroup;
      addCfnGuardSuppression(logGroup, ["CW_LOGGROUP_RETENTION_PERIOD_CHECK"]); // Retention period is defined in CfnMapping and evades the CFN Guard check
    }
    return IsbLogGroups.logGroups[logGroupId];
  }

  public static getAllGroups(scope: Construct, namespace: string): LogGroup[] {
    return [
      IsbLogGroups.globalLogGroup(scope, namespace),
      IsbLogGroups.cleanupLogGroup(scope, namespace),
      IsbLogGroups.authLogGroup(scope, namespace),
      IsbLogGroups.customResourceLogGroup(scope, namespace),
    ];
  }
}
