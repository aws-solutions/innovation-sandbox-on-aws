// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  BlueprintItem,
  BlueprintWithStackSets,
  DeploymentHistoryItem,
  StackSetItem,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import {
  OptionalItem,
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";

export type BlueprintKey = {
  blueprintId: string;
};

export abstract class BlueprintStore {
  abstract createBlueprintWithStackSet(
    blueprint: BlueprintItem,
    stackSet: StackSetItem,
  ): Promise<BlueprintWithStackSets>;

  abstract update<T extends BlueprintItem>(
    blueprint: T,
    expected?: T,
  ): Promise<PutResult<T>>;

  abstract updateBlueprintWithStackSet(
    blueprint: BlueprintItem,
    stackSet: StackSetItem,
  ): Promise<BlueprintWithStackSets>;

  transactionalUpdate<T extends BlueprintItem>(
    blueprint: T,
  ): Transaction<PutResult<T>> {
    return new Transaction({
      beginTransaction: async () => {
        return this.update(blueprint);
      },
      rollbackTransaction: async (putResult) => {
        await this.update(
          putResult.oldItem as BlueprintItem,
          putResult.newItem,
        );
      },
    });
  }

  abstract delete(key: BlueprintKey): Promise<OptionalItem>;

  /**
   * Returns blueprints enriched with recent deployment history (last 10).
   * StackSets array is empty for performance - use get() for complete details.
   */
  abstract listBlueprints(props?: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<BlueprintWithStackSets>>;

  abstract get(
    blueprintId: string,
  ): Promise<SingleItemResult<BlueprintWithStackSets>>;

  abstract recordDeploymentStart(props: {
    blueprintId: string;
    stackSetId: string;
    leaseId: string;
    accountId: string;
    operationId: string;
    deploymentStartedAt: string;
  }): Promise<DeploymentHistoryItem>;

  abstract getDeploymentHistory(
    blueprintId: string,
    props?: {
      pageIdentifier?: string;
      pageSize?: number;
    },
  ): Promise<PaginatedQueryResult<DeploymentHistoryItem>>;

  abstract updateDeploymentStatusAndMetrics(props: {
    blueprintId: string;
    stackSetId: string;
    deploymentSK: string;
    status: "SUCCEEDED" | "FAILED";
    duration: number;
    deploymentTimestamp: string;
    errorType?: string;
    errorMessage?: string;
  }): Promise<void>;
}
