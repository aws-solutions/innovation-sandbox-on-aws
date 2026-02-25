// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { SSMProvider } from "@aws-lambda-powertools/parameters/ssm";

import {
  DataConfig,
  DataConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/data-stack-config/data-stack-config.js";

/**
 * Abstract store for fetching Data Stack configuration from SSM Parameter Store.
 *
 * This configuration is created by the Data Stack and stored in SSM Parameter Store
 * as a JSON string. It contains DynamoDB table names, AppConfig IDs, and KMS key information.
 */
export abstract class DataStackConfigStore {
  abstract get(): Promise<DataConfig>;
}

/**
 * SSM-based implementation of DataStackConfigStore.
 *
 * Uses Lambda Powertools SSMProvider for built-in caching and error handling.
 * The SSMProvider should be shared across all config stores to ensure cache effectiveness.
 */
export class SsmDataStackConfigStore extends DataStackConfigStore {
  private readonly parameterArn: string;
  private readonly ssmProvider: SSMProvider;
  private readonly maxAge: number;

  constructor(props: {
    parameterArn: string;
    ssmProvider: SSMProvider;
    maxAge?: number;
  }) {
    super();
    this.parameterArn = props.parameterArn;
    this.maxAge = props.maxAge ?? 300; // Default 5 minutes cache
    this.ssmProvider = props.ssmProvider;
  }

  public override async get(): Promise<DataConfig> {
    const rawConfig = await this.ssmProvider.get(this.parameterArn, {
      transform: "json",
      maxAge: this.maxAge,
    });

    return DataConfigSchema.parse(rawConfig);
  }
}
