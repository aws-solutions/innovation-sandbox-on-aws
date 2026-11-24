// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ArnFormat, Stack } from "aws-cdk-lib";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "node:path";

import { ConfigMigratorLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-migrator-lambda-environment.js";
import { IsbLambdaFunctionCustomResource } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function-custom-resource";

export type ConfigMigratorProps = {
  namespace: string;
  appConfigApplicationId: string;
  appConfigApplicationArn: string;
  appConfigEnvironmentId: string;
  configTableName: string;
  configTableArn: string;
  tableKmsKeyId: string;
};

/**
 * Wires the Upgrade Migrator Lambda into the Data Stack as a CloudFormation
 * custom resource and grants it least-privilege IAM. The migrator has elevated
 * permissions no other Lambda has (AppConfig read AND DynamoDB write), so each
 * grant is scoped as tightly as the migrator's actual behavior allows.
 *
 * No explicit `DependsOn` on the Config Table is declared — CDK infers the
 * dependency from the `configTableName`/`configTableArn` token references.
 */
export class ConfigMigrator extends Construct {
  constructor(scope: Construct, id: string, props: ConfigMigratorProps) {
    super(scope, id);

    const { lambdaFunction } = new IsbLambdaFunctionCustomResource(
      this,
      "ConfigMigratorLambdaFunction",
      {
        description:
          "Custom resource lambda that migrates AppConfig configuration to DynamoDB",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "custom-resources",
          "config-migrator",
          "src",
          "config-migrator-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        customResourceType: "Custom::ConfigMigrator",
        envSchema: ConfigMigratorLambdaEnvironmentSchema,
        environment: {
          APP_CONFIG_APPLICATION_ID: props.appConfigApplicationId,
          APP_CONFIG_ENVIRONMENT_ID: props.appConfigEnvironmentId,
          CONFIG_TABLE_NAME: props.configTableName,
        },
      },
    );

    // AppConfig control plane: list profiles to discover GlobalConfig/ReportingConfig
    // by name (the migrator is given no profile IDs — those profiles are deleted in
    // the same deploy). ListConfigurationProfiles authorizes against the
    // application-level ARN.
    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["appconfig:ListConfigurationProfiles"],
        resources: [props.appConfigApplicationArn],
      }),
    );

    // AppConfig data plane: read the discovered profiles. StartConfigurationSession
    // and GetLatestConfiguration authorize against the configuration-level ARN, not
    // the application ARN. The profile id is wildcarded because it is discovered at
    // runtime; the scope stays within this single ISB application + environment.
    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "appconfig:StartConfigurationSession",
          "appconfig:GetLatestConfiguration",
        ],
        resources: [
          Stack.of(scope).formatArn({
            service: "appconfig",
            resource: `application/${props.appConfigApplicationId}/environment/${props.appConfigEnvironmentId}/configuration/*`,
            arnFormat: ArnFormat.NO_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // DynamoDB, scoped to the Config Table only. BatchGetItem for the
    // destination-first idempotency check (getAllSections), PutItem for the
    // migration write (TransactWriteItems uses PutItem internally). Deliberately
    // NOT grantIsbDbReadWrite, which also grants Delete/Update/Query.
    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:BatchGetItem", "dynamodb:PutItem"],
        resources: [props.configTableArn],
      }),
    );

    // KMS, scoped to the Config Table encryption key — PutItem against a
    // customer-managed-encrypted table needs GenerateDataKey/Encrypt, plus
    // Decrypt/DescribeKey for the encryption context.
    lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "kms:Decrypt",
          "kms:Encrypt",
          "kms:GenerateDataKey",
          "kms:DescribeKey",
        ],
        resources: [
          Stack.of(scope).formatArn({
            service: "kms",
            resource: "key",
            resourceName: props.tableKmsKeyId,
          }),
        ],
      }),
    );
  }
}
