// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  EmailAddress,
  OptionalItem,
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  ExpiredLeaseStatus,
  Lease,
  LeaseKey,
  LeaseStatus,
  MonitoredLeaseStatus,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";

export abstract class LeaseStore {
  abstract create<T extends Lease>(lease: T): Promise<T>;

  abstract update<T extends Lease>(
    lease: T,
    expected?: T, //fail the update if the lease has been modified from the expected (uses lastEdit meta)
  ): Promise<PutResult<T>>;

  transactionalUpdate<T extends Lease>(lease: T): Transaction<PutResult<T>> {
    return new Transaction({
      beginTransaction: async () => {
        return this.update(lease);
      },
      rollbackTransaction: async (putResult) => {
        await this.update(putResult.oldItem as Lease, putResult.newItem);
      },
    });
  }

  abstract delete(key: LeaseKey): Promise<OptionalItem>;

  abstract get(key: LeaseKey): Promise<SingleItemResult<Lease>>;

  abstract findAll(props: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>>;

  abstract findByUserEmail(props: {
    userEmail: EmailAddress;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>>;

  abstract findByLeaseTemplateUuid(props: {
    status: LeaseStatus;
    uuid: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>>;

  abstract findByStatus(props: {
    status: LeaseStatus;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>>;

  abstract findByStatusAndAccountID(props: {
    status: MonitoredLeaseStatus | ExpiredLeaseStatus;
    awsAccountId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>>;
}
