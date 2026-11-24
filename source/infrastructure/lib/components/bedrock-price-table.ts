// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { RemovalPolicy } from "aws-cdk-lib";
import {
  AttributeType,
  BillingMode,
  ITable,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";

export interface BedrockPriceTableProps {
  readonly namespace: string;
}

/** Stores regional Bedrock model prices shared by pricing consumers. */
export class BedrockPriceTable extends Construct {
  public readonly table: ITable;

  constructor(scope: Construct, id: string, props: BedrockPriceTableProps) {
    super(scope, id);

    this.table = new Table(this, "Default", {
      partitionKey: { name: "modelId", type: AttributeType.STRING },
      sortKey: { name: "region", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: IsbKmsKeys.get(scope, props.namespace),
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });
  }
}
