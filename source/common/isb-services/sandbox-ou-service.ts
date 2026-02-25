// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  Account,
  ConcurrentModificationException,
  DescribeAccountCommand,
  ListAccountsForParentCommand,
  MoveAccountCommand,
  OrganizationsClient,
  paginateListAccountsForParent,
  TooManyRequestsException,
} from "@aws-sdk/client-organizations";

import { AccountPoolStackConfigStore } from "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/ssm-account-pool-stack-config-store.js";
import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import {
  IsbOu,
  SandboxAccount,
  SandboxAccountStatus,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";
import { backOff } from "exponential-backoff";

export class SandboxOuService {
  readonly orgsClient: OrganizationsClient;
  readonly sandboxAccountStore: SandboxAccountStore;
  readonly accountPoolStackConfigStore: AccountPoolStackConfigStore;

  constructor(props: {
    sandboxAccountStore: SandboxAccountStore;
    orgsClient: OrganizationsClient;
    accountPoolStackConfigStore: AccountPoolStackConfigStore;
  }) {
    this.orgsClient = props.orgsClient;
    this.sandboxAccountStore = props.sandboxAccountStore;
    this.accountPoolStackConfigStore = props.accountPoolStackConfigStore;
  }

  private async getIsbOuId(ouName: IsbOu): Promise<string> {
    // SSMProvider in the store already caches for 5 minutes
    const config = await this.accountPoolStackConfigStore.get();

    // Map OU names to IDs from AccountPoolConfig SSM Parameter
    const ouIdMap: Record<IsbOu, string> = {
      Available: config.availableOuId,
      Active: config.activeOuId,
      Frozen: config.frozenOuId,
      CleanUp: config.cleanupOuId,
      Quarantine: config.quarantineOuId,
      Entry: config.entryOuId,
      Exit: config.exitOuId,
    };

    const ouId = ouIdMap[ouName];
    if (!ouId) {
      throw new Error(
        `Requested OU not found in Innovation Sandbox: ${ouName}`,
      );
    }

    return ouId;
  }

  public async performAccountMoveAction(
    accountId: string,
    sourceOu: IsbOu,
    destinationOu: IsbOu,
  ) {
    const sourceOuId = await this.getIsbOuId(sourceOu);
    const destinationOuId = await this.getIsbOuId(destinationOu);

    await backOff(
      () =>
        this.orgsClient.send(
          new MoveAccountCommand({
            AccountId: accountId,
            SourceParentId: sourceOuId,
            DestinationParentId: destinationOuId,
          }),
        ),
      {
        numOfAttempts: 5,
        jitter: "full",
        startingDelay: 1000,
        retry(error) {
          if (
            error instanceof ConcurrentModificationException ||
            error instanceof TooManyRequestsException
          ) {
            return true;
          }
          return false;
        },
      },
    );
  }

  public async moveAccount(
    account: SandboxAccount,
    sourceOu: IsbOu,
    destinationOu: IsbOu,
  ) {
    await this.performAccountMoveAction(
      account.awsAccountId,
      sourceOu,
      destinationOu,
    );
    return this.sandboxAccountStore.put({
      ...account,
      status: destinationOu as SandboxAccountStatus,
    });
  }

  public transactionalMoveAccount(
    account: SandboxAccount,
    sourceOu: IsbOu,
    destinationOu: IsbOu,
  ) {
    return new Transaction({
      beginTransaction: () =>
        this.moveAccount(account, sourceOu, destinationOu),
      rollbackTransaction: async () => {
        await this.moveAccount(account, destinationOu, sourceOu); // NOSONAR typescript:S2234 - function parameters not matching the parameter names is intentional
      },
    });
  }

  public async listAllAccountsInOU(ouName: IsbOu) {
    const listAccountsPaginator = paginateListAccountsForParent(
      {
        client: this.orgsClient,
      },
      {
        ParentId: await this.getIsbOuId(ouName),
      },
    );

    const accounts: Account[] = [];
    for await (const page of listAccountsPaginator) {
      if (page.Accounts) {
        accounts.push(...page.Accounts);
      }
    }
    return accounts;
  }

  public async listAccountsInOU(options: {
    ouName: IsbOu;
    pageSize?: number;
    pageIdentifier?: string;
  }) {
    const { ouName, pageIdentifier, pageSize } = options;
    const { Accounts, NextToken } = await this.orgsClient.send(
      new ListAccountsForParentCommand({
        ParentId: await this.getIsbOuId(ouName),
        NextToken: pageIdentifier,
        MaxResults: pageSize,
      }),
    );

    return {
      accounts: Accounts,
      nextPageIdentifier: NextToken,
    };
  }

  public async describeAccount(options: { accountId: string }) {
    const { accountId } = options;
    const { Account } = await this.orgsClient.send(
      new DescribeAccountCommand({ AccountId: accountId }),
    );

    return (
      Account && {
        accountId: Account.Id,
        name: Account.Name,
        email: Account.Email,
      }
    );
  }
}
