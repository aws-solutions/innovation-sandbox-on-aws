// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Context, EventBridgeEvent } from "aws-lambda";

import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import { PersistedSandboxAccount } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { stream } from "@amzn/innovation-sandbox-commons/data/utils.js";
import { AccountDriftDetectedAlert } from "@amzn/innovation-sandbox-commons/events/account-drift-detected-alert.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import {
  AccountDriftMonitoringEnvironment,
  AccountDriftMonitoringEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/account-drift-monitoring-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import {
  LogPatterns,
  searchableAccountProperties,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  IsbOu,
  IsbOuSchema,
} from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";

const serviceName = "AccountDriftMonitoring";
const tracer = new Tracer();
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: AccountDriftMonitoringEnvironmentSchema,
  moduleName: "account-drift-monitoring",
}).handler(doAccountDriftMonitoring);

export async function doAccountDriftMonitoring(
  _event: EventBridgeEvent<string, unknown>,
  context: Context & ValidatedEnvironment<AccountDriftMonitoringEnvironment>,
) {
  const isbEventBridge = IsbServices.isbEventBridge(context.env);
  const orgsService = IsbServices.orgsService(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );
  const accountStore = IsbServices.sandboxAccountStore(context.env);

  const driftStatus = await detectDriftStatus(orgsService, accountStore);

  const promises = [];

  for (const driftingAccount of driftStatus.accountsInDrift.filter(
    (event) => event.account.driftAtLastScan,
  )) {
    logger.warn(
      `${LogPatterns.AccountDrift.pattern}: (${driftingAccount.account.awsAccountId}) sending message to ISB bus`,
      {
        ...searchableAccountProperties(driftingAccount.account),
        logDetailType: "AccountDrift",
        accountId: driftingAccount.account.awsAccountId,
        expectedOu: driftingAccount.expectedOu,
        actualOu: driftingAccount.actualOu,
      } satisfies SubscribableLog,
    );
    promises.push(
      isbEventBridge.sendIsbEvents(
        tracer,
        new AccountDriftDetectedAlert({
          accountId: driftingAccount.account.awsAccountId,
          expectedOu: driftingAccount.expectedOu,
          actualOu: driftingAccount.actualOu,
        }),
      ),
    );
  }

  for (const newlyDriftingAccount of driftStatus.accountsInDrift.filter(
    (event) => !event.account.driftAtLastScan,
  )) {
    logger.info(
      `Potential account drift detected for (${newlyDriftingAccount.account.awsAccountId}), updating in db`,
      {
        ...searchableAccountProperties(newlyDriftingAccount.account),
      },
    );
    promises.push(
      accountStore.put({
        ...newlyDriftingAccount.account,
        driftAtLastScan: true,
      }),
    );
  }

  for (const noLongerDriftingAccount of driftStatus.accountsNotInDrift.filter(
    (account) => account.driftAtLastScan,
  )) {
    logger.info(
      `Account (${noLongerDriftingAccount.awsAccountId}) no longer in drift, updating in db`,
      {
        ...searchableAccountProperties(noLongerDriftingAccount),
      },
    );
    promises.push(
      accountStore.put({
        ...noLongerDriftingAccount,
        driftAtLastScan: false,
      }),
    );
  }

  for (const [untrackedAccountId, inOu] of driftStatus.untrackedAccounts) {
    if (inOu == "Entry" || inOu == "Exit") {
      continue; //expected
    }
    logger.warn(
      `${LogPatterns.AccountDrift.pattern}: Untracked account (${untrackedAccountId}) found in ${inOu} OU!, sending message to ISB bus`,
      {
        logDetailType: "AccountDrift",
        accountId: untrackedAccountId,
        expectedOu: undefined,
        actualOu: inOu,
      } satisfies SubscribableLog,
    );
    promises.push(
      isbEventBridge.sendIsbEvents(
        tracer,
        new AccountDriftDetectedAlert({
          accountId: untrackedAccountId,
          expectedOu: undefined,
          actualOu: inOu,
        }),
      ),
    );
  }

  await Promise.all(promises);
}

async function detectDriftStatus(
  orgsService: SandboxOuService,
  accountStore: SandboxAccountStore,
) {
  const untrackedAccounts = await discoverAllAccountsInOUs(orgsService);
  const accountsNotInDrift: PersistedSandboxAccount[] = [];
  const accountsInDrift: {
    account: PersistedSandboxAccount;
    actualOu?: IsbOu;
    expectedOu: IsbOu;
  }[] = [];

  for await (const account of stream(accountStore, accountStore.findAll, {})) {
    const actualOu = untrackedAccounts.get(account.awsAccountId);

    if (account.status === actualOu) {
      accountsNotInDrift.push(account);
    } else {
      accountsInDrift.push({
        account: account,
        actualOu: actualOu,
        expectedOu: account.status,
      });
    }

    untrackedAccounts.delete(account.awsAccountId);
  }

  return {
    accountsNotInDrift,
    accountsInDrift,
    untrackedAccounts, //accounts in IsbOUs but not tracked by the accountDB
  };
}

async function discoverAllAccountsInOUs(orgsService: SandboxOuService) {
  const accountOus = new Map<string, IsbOu>();
  for (const isbOu of IsbOuSchema.options) {
    for (const account of await orgsService.listAllAccountsInOU(isbOu)) {
      if (account.Id) accountOus.set(account.Id, isbOu);
    }
  }
  return accountOus;
}
