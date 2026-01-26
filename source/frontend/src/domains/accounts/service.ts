// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SandboxAccount } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { UnregisteredAccount } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";
import {
  ApiProxy,
  IApiProxy,
} from "@amzn/innovation-sandbox-frontend/helpers/ApiProxy";
import { ApiPaginatedResult } from "@amzn/innovation-sandbox-frontend/types";

export class AccountService {
  private api: IApiProxy;

  constructor(apiProxy?: IApiProxy) {
    this.api = apiProxy ?? new ApiProxy();
  }

  async getAccounts(): Promise<SandboxAccount[]> {
    let allAccounts: SandboxAccount[] = [];
    let nextPageIdentifier: string | null = null;

    // keep calling the API until all accounts are collected
    do {
      const url: string = nextPageIdentifier
        ? `/accounts?pageIdentifier=${nextPageIdentifier}`
        : "/accounts";

      const response =
        await this.api.get<ApiPaginatedResult<SandboxAccount>>(url);

      allAccounts = [...allAccounts, ...response.result];
      nextPageIdentifier = response.nextPageIdentifier;
    } while (nextPageIdentifier !== null);

    return allAccounts;
  }

  async getUnregisteredAccounts(): Promise<UnregisteredAccount[]> {
    let allAccounts: UnregisteredAccount[] = [];
    let nextPageIdentifier: string | null = null;

    // keep calling the API until all accounts are collected
    do {
      const url: string = nextPageIdentifier
        ? `/accounts/unregistered?pageIdentifier=${encodeURIComponent(nextPageIdentifier)}`
        : "/accounts/unregistered";

      const response =
        await this.api.get<ApiPaginatedResult<UnregisteredAccount>>(url);

      allAccounts = [...allAccounts, ...response.result];
      nextPageIdentifier = response.nextPageIdentifier;
    } while (nextPageIdentifier !== null && nextPageIdentifier !== undefined);

    return allAccounts;
  }

  async getAccountById(id: string): Promise<SandboxAccount> {
    const accounts = await this.api.get<SandboxAccount>(`/accounts/${id}`);
    return accounts;
  }

  async addAccount(awsAccountId: string): Promise<void> {
    await this.api.post(`/accounts`, { awsAccountId });
  }

  async ejectAccount(awsAccountId: string): Promise<void> {
    await this.api.post(`/accounts/${awsAccountId}/eject`);
  }

  async cleanupAccount(awsAccountId: string): Promise<void> {
    await this.api.post(`/accounts/${awsAccountId}/retryCleanup`);
  }

  async quarantineAccount(awsAccountId: string): Promise<void> {
    await this.api.post(`/accounts/${awsAccountId}/quarantine`);
  }
}
