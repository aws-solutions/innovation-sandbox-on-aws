// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  OptionalItem,
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import { PersistedSandboxAccount } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";
import { SandboxAccountStatus } from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";

export abstract class SandboxAccountStore {
  abstract put(
    account: PersistedSandboxAccount,
  ): Promise<PutResult<PersistedSandboxAccount>>;

  transactionalPut(
    account: PersistedSandboxAccount,
  ): Transaction<PutResult<PersistedSandboxAccount>> {
    return new Transaction({
      beginTransaction: async () => {
        return this.put(account);
      },
      rollbackTransaction: async (putResult) => {
        if (putResult.oldItem) {
          await this.put(putResult.oldItem as PersistedSandboxAccount);
        } else {
          await this.delete(account.awsAccountId);
        }
      },
    });
  }

  abstract delete(accountId: string): Promise<OptionalItem>;

  abstract findByStatus(args: {
    status: SandboxAccountStatus;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedSandboxAccount>>;

  abstract findAll(args: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedSandboxAccount>>;

  abstract get(
    accountId: string,
  ): Promise<SingleItemResult<PersistedSandboxAccount>>;

  /**
   * Partially updates specific fields on an account record using DynamoDB UpdateCommand.
   * Only touches the specified fields — does not overwrite the entire item.
   * Automatically updates `meta.lastEditTime`.
   *
   * Semantics:
   * - `set`: fields to SET (including null values, which store DynamoDB NULL type)
   * - `remove`: field names to REMOVE (delete the attribute from the item).
   *   Only optional fields can be removed — required fields (`status`) are excluded.
   */
  abstract update(
    accountId: string,
    params: {
      set?: Partial<Omit<PersistedSandboxAccount, "awsAccountId" | "meta">>;
      remove?: Array<
        keyof Omit<PersistedSandboxAccount, "awsAccountId" | "meta" | "status">
      >;
    },
  ): Promise<void>;

  abstract acquireLock(
    accountId: string,
    ownerId: string,
    timeoutSeconds: number,
    meta?: Record<string, string>,
  ): Promise<PersistedSandboxAccount>;

  /**
   * Releases the lock only if held by `ownerId`. Returns true when this owner
   * held the lock and it was removed; false when the lock was absent, already
   * released, or owned by a different execution (a no-op).
   */
  abstract releaseLock(accountId: string, ownerId: string): Promise<boolean>;
}
