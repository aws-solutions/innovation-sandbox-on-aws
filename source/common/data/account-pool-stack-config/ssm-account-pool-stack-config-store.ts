// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { SSMProvider } from "@aws-lambda-powertools/parameters/ssm";

import {
  AccountPoolConfig,
  AccountPoolConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/account-pool-stack-config.js";

/**
 * Abstract store for fetching Account Pool Stack configuration from SSM Parameter Store.
 *
 * This configuration is created by the Account Pool Stack and stored in SSM Parameter Store
 * as a JSON string. It contains organizational unit IDs and regional settings.
 */
export abstract class AccountPoolStackConfigStore {
  abstract get(): Promise<AccountPoolConfig>;
}

/**
 * SSM-based implementation of AccountPoolStackConfigStore.
 *
 * Uses Lambda Powertools SSMProvider for built-in caching and error handling.
 * The SSMProvider should be shared across all config stores to ensure cache effectiveness.
 */
export class SsmAccountPoolStackConfigStore extends AccountPoolStackConfigStore {
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

  public override async get(): Promise<AccountPoolConfig> {
    const rawConfig = await this.ssmProvider.get(this.parameterArn, {
      transform: "json",
      maxAge: this.maxAge,
    });

    return AccountPoolConfigSchema.parse(rawConfig);
  }
}
