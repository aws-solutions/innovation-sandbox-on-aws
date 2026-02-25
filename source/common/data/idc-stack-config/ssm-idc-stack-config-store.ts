// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { SSMProvider } from "@aws-lambda-powertools/parameters/ssm";

import {
  IdcConfig,
  IdcConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/idc-stack-config/idc-stack-config.js";

/**
 * Abstract store for fetching IDC Stack configuration from SSM Parameter Store.
 *
 * This configuration is created by the IDC Stack and stored in SSM Parameter Store
 * as a JSON string. It contains Identity Center IDs, group IDs, and permission set ARNs.
 */
export abstract class IdcStackConfigStore {
  abstract get(): Promise<IdcConfig>;
}

/**
 * SSM-based implementation of IdcStackConfigStore.
 *
 * Uses Lambda Powertools SSMProvider for built-in caching and error handling.
 * The SSMProvider should be shared across all config stores to ensure cache effectiveness.
 */
export class SsmIdcStackConfigStore extends IdcStackConfigStore {
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

  public override async get(): Promise<IdcConfig> {
    const rawConfig = await this.ssmProvider.get(this.parameterArn, {
      transform: "json",
      maxAge: this.maxAge,
    });

    return IdcConfigSchema.parse(rawConfig);
  }
}
