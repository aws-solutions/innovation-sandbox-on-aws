// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { RemovalPolicy, aws_ssm } from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { Key } from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

import { sharedDataSsmParamName } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { Config } from "@amzn/innovation-sandbox-infrastructure/components/config/config";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { isDevMode } from "@amzn/innovation-sandbox-infrastructure/helpers/deployment-mode";
import { DataConfig } from "@amzn/innovation-sandbox-shared-json-param-parser/src/shared-json-param-parser-handler.js";

const supportedSchemas = ["1"];

export interface IsbDataResourcesProps {
  readonly namespace: string;
}
export class IsbDataResources {
  tableKmsKey: Key;
  config: Config;
  sandboxAccountTable: Table;
  leaseTemplateTable: Table;
  leaseTable: Table;

  constructor(scope: Construct, props: IsbDataResourcesProps) {
    this.tableKmsKey = IsbKmsKeys.get(scope, props.namespace);

    this.config = new Config(scope, "Config", {
      namespace: props.namespace,
    });

    const devMode = isDevMode(scope);
    const tableRemovalPolicy = devMode
      ? RemovalPolicy.DESTROY
      : RemovalPolicy.RETAIN;
    this.sandboxAccountTable = new Table(scope, "SandboxAccountTable", {
      partitionKey: { name: "awsAccountId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: !devMode,
      removalPolicy: tableRemovalPolicy,
      encryptionKey: this.tableKmsKey,
      encryption: TableEncryption.CUSTOMER_MANAGED,
    });

    this.leaseTemplateTable = new Table(scope, "LeaseTemplateTable", {
      partitionKey: { name: "uuid", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: !devMode,
      removalPolicy: tableRemovalPolicy,
      encryptionKey: this.tableKmsKey,
      encryption: TableEncryption.CUSTOMER_MANAGED,
    });

    this.leaseTable = new Table(scope, "LeaseTable", {
      partitionKey: { name: "userEmail", type: AttributeType.STRING },
      sortKey: { name: "uuid", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.tableKmsKey,
      deletionProtection: !devMode,
      removalPolicy: tableRemovalPolicy,
      timeToLiveAttribute: "ttl",
    });
    this.leaseTable.addGlobalSecondaryIndex({
      indexName: "StatusIndex",
      partitionKey: {
        name: "status",
        type: AttributeType.STRING,
      },
      sortKey: {
        name: "originalLeaseTemplateUuid",
        type: AttributeType.STRING,
      },
    });

    new aws_ssm.StringParameter(scope, "DataConfiguration", {
      parameterName: sharedDataSsmParamName(props.namespace),
      description: "The configuration of the data stack of Innovation Sandbox",
      stringValue: JSON.stringify({
        configApplicationId: this.config.application.applicationId,
        configEnvironmentId: this.config.environment.environmentId,
        globalConfigConfigurationProfileId:
          this.config.globalConfigHostedConfiguration.configurationProfileId,
        nukeConfigConfigurationProfileId:
          this.config.nukeConfigHostedConfiguration.configurationProfileId,
        reportingConfigConfigurationProfileId:
          this.config.reportingConfigHostedConfiguration.configurationProfileId,
        accountTable: this.sandboxAccountTable.tableName,
        leaseTemplateTable: this.leaseTemplateTable.tableName,
        leaseTable: this.leaseTable.tableName,
        tableKmsKeyId: this.tableKmsKey.keyId,
        solutionVersion: getContextFromMapping(scope, "version"),
        supportedSchemas: JSON.stringify(supportedSchemas),
      } satisfies DataConfig),
      simpleName: true,
    });
  }
}
