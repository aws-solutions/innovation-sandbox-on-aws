// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { SendDurableExecutionCallbackSuccessCommand } from "@aws-sdk/client-lambda";
import { z } from "zod";

import { CleanupReportKey } from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import {
  AccountInCleanUpError,
  AccountNotInQuarantineError,
  InnovationSandbox,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { AccountLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { withDelegatedErrors } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";
import { parseRawJsonBody } from "@amzn/innovation-sandbox-commons/lambda/smithy/parse-raw-json-body.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import {
  fromTemporaryIsbIdcCredentials,
  fromTemporaryIsbOrgManagementCredentials,
} from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import { getUserEmail } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

import type {
  AccountsApiService,
  EjectAccountServerInput,
  EjectAccountServerOutput,
  GetAccountServerInput,
  GetAccountServerOutput,
  ListAccountsServerInput,
  ListAccountsServerOutput,
  ListCleanupReportsServerInput,
  ListCleanupReportsServerOutput,
  ListUnregisteredAccountsServerInput,
  ListUnregisteredAccountsServerOutput,
  QuarantineAccountServerInput,
  QuarantineAccountServerOutput,
  RegisterAccountServerInput,
  RegisterAccountServerOutput,
  RetryCleanupServerInput,
  RetryCleanupServerOutput,
  SkipCooldownServerInput,
  SkipCooldownServerOutput,
} from "@amzn/innovation-sandbox-api-server/accounts";
import { JSendStatus } from "@amzn/innovation-sandbox-api-server/accounts";

export type AccountsSmithyContext = IsbSmithyContext<AccountLambdaEnvironment>;

const tracer = new Tracer();

// Pre-Smithy pagination defaults (`createPaginationQueryStringParametersSchema`
// applied `maxResults` defaults). The model validates the range; the operation
// applies the default when `maxResults` is absent — defaults are operation
// behavior, not model traits, so they stay here.
const LIST_ACCOUNTS_DEFAULT_MAX = 2000;
const LIST_UNREGISTERED_DEFAULT_MAX = 20;
const LIST_CLEANUP_REPORTS_DEFAULT_MAX = 5;

// Registration body contract: a standalone strict schema (Task 3.4a/b), NOT
// derived from `PersistedSandboxAccountSchema`. It accepts only the modeled input field,
// `awsAccountId`, and rejects any unknown key (preserving the pre-Smithy
// `.strict()` behavior). Decoupling from the persistence schema means a future
// account field cannot silently widen what registration accepts.
const RegisterAccountBodySchema = z
  .object({ awsAccountId: AwsAccountIdSchema })
  .strict();

const ACCOUNT_NOT_FOUND = {
  statusCode: 404 as const,
  data: { errors: [{ message: "Account not found." }] },
};

/** Load an account, or throw the delegated 404 the pre-Smithy handler returned. */
async function requireAccount(
  logger: Logger,
  env: AccountLambdaEnvironment,
  awsAccountId: string,
) {
  const accountStore = IsbServices.sandboxAccountStore(env);
  const accountResponse = await accountStore.get(awsAccountId);
  if (accountResponse.error) {
    logger.warn(
      `${LogPatterns.DataValidationWarning.pattern}: Error in retrieving account ${awsAccountId}: ${accountResponse.error}`,
    );
  }
  if (!accountResponse.result) {
    throw createHttpJSendError(ACCOUNT_NOT_FOUND);
  }
  return accountResponse.result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
function listAccounts(logger: Logger) {
  return async (
    input: ListAccountsServerInput,
    context: AccountsSmithyContext,
  ): Promise<ListAccountsServerOutput> => {
    const { env } = context.lambdaContext;
    const accountStore = IsbServices.sandboxAccountStore(env);

    const queryResult = await accountStore.findAll({
      pageIdentifier: input.pageIdentifier,
      pageSize: input.maxResults ?? LIST_ACCOUNTS_DEFAULT_MAX,
    });
    if (queryResult.error) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: Error while fetching accounts: ${queryResult.error}`,
      );
    }
    // Return the raw store result; the serializer projects to the modeled shape
    // (dropping only each account's internal `meta.schemaVersion` — `resourceLock`
    // IS modeled and emitted, the frontend reads `resourceLock.expiresAt`). The
    // optional `error` diagnostic is modeled, so it survives byte-faithfully. The
    // cast bridges the store type (richer members, `nextPageIdentifier: null`) to
    // the modeled output — the serializer, not TS, enforces the wire shape.
    return {
      status: JSendStatus.SUCCESS,
      data: queryResult as unknown as ListAccountsServerOutput["data"],
    };
  };
}

function getAccount(logger: Logger) {
  return async (
    input: GetAccountServerInput,
    context: AccountsSmithyContext,
  ): Promise<GetAccountServerOutput> => {
    const account = await requireAccount(
      logger,
      context.lambdaContext.env,
      input.awsAccountId,
    );
    return {
      status: JSendStatus.SUCCESS,
      data: account,
    };
  };
}

function listUnregisteredAccounts(_logger: Logger) {
  return async (
    input: ListUnregisteredAccountsServerInput,
    context: AccountsSmithyContext,
  ): Promise<ListUnregisteredAccountsServerOutput> => {
    const { env } = context.lambdaContext;
    const orgService = IsbServices.orgsService(
      env,
      fromTemporaryIsbOrgManagementCredentials(env),
    );

    const unregisteredAccounts = await orgService.listAccountsInOU({
      ouName: "Entry",
      pageIdentifier: input.pageIdentifier,
      pageSize: input.maxResults ?? LIST_UNREGISTERED_DEFAULT_MAX,
    });

    return {
      status: JSendStatus.SUCCESS,
      data: {
        result:
          unregisteredAccounts.accounts?.map((account) => ({
            Id: account.Id,
            Email: account.Email,
            Name: account.Name,
          })) ?? [],
        nextPageIdentifier: unregisteredAccounts.nextPageIdentifier,
      } as unknown as ListUnregisteredAccountsServerOutput["data"],
    };
  };
}

function listCleanupReports(_logger: Logger) {
  return async (
    input: ListCleanupReportsServerInput,
    context: AccountsSmithyContext,
  ): Promise<ListCleanupReportsServerOutput> => {
    const { env } = context.lambdaContext;
    const cleanupReportStore = IsbServices.cleanupReportStore(env);
    const queryResult = await cleanupReportStore.listRecentReports({
      accountId: input.awsAccountId,
      limit: input.maxResults ?? LIST_CLEANUP_REPORTS_DEFAULT_MAX,
      pageIdentifier: input.pageIdentifier ?? undefined,
    });

    // Raw reports are returned; the serializer projects each to the modeled
    // `toApiResponse` shape (internal pk/sk/ttl/meta/… are dropped). The cast
    // bridges the store types to the modeled output; the serializer enforces the
    // wire shape.
    return {
      status: JSendStatus.SUCCESS,
      data: {
        result: queryResult.result,
        nextPageIdentifier: queryResult.nextPageIdentifier,
      },
    } as unknown as ListCleanupReportsServerOutput;
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
function registerAccount(_logger: Logger) {
  return async (
    _input: RegisterAccountServerInput,
    context: AccountsSmithyContext,
  ): Promise<RegisterAccountServerOutput> => {
    const { env, user: _user } = context.lambdaContext;
    // Re-parse the raw body against the standalone strict registration schema so
    // unknown keys are rejected (the model/deserializer would silently drop them).
    const parsed = RegisterAccountBodySchema.safeParse(
      parseRawJsonBody(context.event),
    );
    if (!parsed.success) {
      throw createHttpJSendValidationError(parsed.error);
    }

    const { ORG_MGT_ACCOUNT_ID, IDC_ACCOUNT_ID, HUB_ACCOUNT_ID } = env;
    if (
      [ORG_MGT_ACCOUNT_ID, IDC_ACCOUNT_ID, HUB_ACCOUNT_ID].includes(
        parsed.data.awsAccountId,
      )
    ) {
      throw createHttpJSendError({
        statusCode: 400,
        data: {
          errors: [
            {
              message: `Account is an ISB administration account. Aborting registration.`,
            },
          ],
        },
      });
    }

    const result = await InnovationSandbox.registerAccount(
      parsed.data.awsAccountId,
      {
        logger: _logger,
        tracer,
        eventBridgeClient: IsbServices.isbEventBridge(env),
        orgsService: IsbServices.orgsService(
          env,
          fromTemporaryIsbOrgManagementCredentials(env),
        ),
        organizationsTaggingService: IsbServices.organizationsTaggingService(
          env,
          fromTemporaryIsbOrgManagementCredentials(env),
        ),
        idcService: IsbServices.idcService(
          env,
          fromTemporaryIsbIdcCredentials(env),
        ),
      },
    );

    return {
      status: JSendStatus.SUCCESS,
      data: result,
    };
  };
}

// ---------------------------------------------------------------------------
// Custom actions
// ---------------------------------------------------------------------------
function ejectAccount(logger: Logger) {
  return async (
    input: EjectAccountServerInput,
    context: AccountsSmithyContext,
  ): Promise<EjectAccountServerOutput> => {
    const { env, globalConfig } = context.lambdaContext;
    const account = await requireAccount(logger, env, input.awsAccountId);

    try {
      await InnovationSandbox.ejectAccount(
        { sandboxAccount: account },
        {
          logger,
          tracer,
          sandboxAccountStore: IsbServices.sandboxAccountStore(env),
          leaseStore: IsbServices.leaseStore(env),
          orgsService: IsbServices.orgsService(
            env,
            fromTemporaryIsbOrgManagementCredentials(env),
          ),
          organizationsTaggingService: IsbServices.organizationsTaggingService(
            env,
            fromTemporaryIsbOrgManagementCredentials(env),
          ),
          idcService: IsbServices.idcService(
            env,
            fromTemporaryIsbIdcCredentials(env),
          ),
          eventBridgeClient: IsbServices.isbEventBridge(env),
          globalConfig,
          blueprintStore: IsbServices.blueprintStore(env),
          blueprintDeploymentService:
            IsbServices.blueprintDeploymentService(env),
          sandboxSpacesUsageStore: IsbServices.sandboxSpacesUsageStore(env),
        },
      );
    } catch (error) {
      if (error instanceof AccountInCleanUpError) {
        throw createHttpJSendError({
          statusCode: 409,
          data: { errors: [{ message: error.message }] },
        });
      }
      throw error;
    }

    return { status: JSendStatus.SUCCESS };
  };
}

function quarantineAccount(logger: Logger) {
  return async (
    input: QuarantineAccountServerInput,
    context: AccountsSmithyContext,
  ): Promise<QuarantineAccountServerOutput> => {
    const { env, globalConfig } = context.lambdaContext;
    const awsAccountId = input.awsAccountId;
    const accountStore = IsbServices.sandboxAccountStore(env);
    const account = await requireAccount(logger, env, awsAccountId);

    if (account.status === "Quarantine") {
      throw createHttpJSendError({
        statusCode: 409,
        data: { errors: [{ message: `Account is already quarantined.` }] },
      });
    }
    if (account.status === "CleanUp") {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message: `Account cannot be quarantined while cleanup is in progress.`,
            },
          ],
        },
      });
    }

    await InnovationSandbox.quarantineAccount(
      {
        accountId: awsAccountId,
        currentOu: account.status,
        reason: "Manually quarantined by administrator",
        reasonForQuarantine: "MANUAL",
      },
      {
        logger,
        tracer,
        sandboxAccountStore: accountStore,
        leaseStore: IsbServices.leaseStore(env),
        orgsService: IsbServices.orgsService(
          env,
          fromTemporaryIsbOrgManagementCredentials(env),
        ),
        organizationsTaggingService: IsbServices.organizationsTaggingService(
          env,
          fromTemporaryIsbOrgManagementCredentials(env),
        ),
        idcService: IsbServices.idcService(
          env,
          fromTemporaryIsbIdcCredentials(env),
        ),
        eventBridgeClient: IsbServices.isbEventBridge(env),
        globalConfig,
        blueprintStore: IsbServices.blueprintStore(env),
        blueprintDeploymentService: IsbServices.blueprintDeploymentService(env),
        sandboxSpacesUsageStore: IsbServices.sandboxSpacesUsageStore(env),
      },
    );

    return { status: JSendStatus.SUCCESS };
  };
}

function retryCleanup(logger: Logger) {
  return async (
    input: RetryCleanupServerInput,
    context: AccountsSmithyContext,
  ): Promise<RetryCleanupServerOutput> => {
    const { env, user } = context.lambdaContext;
    const accountStore = IsbServices.sandboxAccountStore(env);
    const account = await requireAccount(logger, env, input.awsAccountId);

    try {
      await InnovationSandbox.retryCleanup(
        { sandboxAccount: account, initiatedBy: getUserEmail(user) },
        {
          logger,
          tracer,
          eventBridgeClient: IsbServices.isbEventBridge(env),
          orgsService: IsbServices.orgsService(
            env,
            fromTemporaryIsbOrgManagementCredentials(env),
          ),
          organizationsTaggingService: IsbServices.organizationsTaggingService(
            env,
            fromTemporaryIsbOrgManagementCredentials(env),
          ),
          sandboxAccountStore: accountStore,
        },
      );
    } catch (error) {
      if (
        error instanceof AccountNotInQuarantineError ||
        error instanceof AccountInCleanUpError
      ) {
        throw createHttpJSendError({
          statusCode: 409,
          data: { errors: [{ message: error.message }] },
        });
      }
      throw error;
    }

    return { status: JSendStatus.SUCCESS };
  };
}

function skipCooldown(logger: Logger) {
  return async (
    input: SkipCooldownServerInput,
    context: AccountsSmithyContext,
  ): Promise<SkipCooldownServerOutput> => {
    const { env, user } = context.lambdaContext;
    const awsAccountId = input.awsAccountId;
    const cleanupReportStore = IsbServices.cleanupReportStore(env);
    const latestReport = await cleanupReportStore.getLatestReport(awsAccountId);

    const report = latestReport.result;
    if (
      report?.status !== "IN_PROGRESS" ||
      report.cleanupStatus !== "COOLING_DOWN"
    ) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [{ message: "Account is not in an active cooldown." }],
        },
      });
    }

    if (!report.skipCooldownCallbackId) {
      throw createHttpJSendError({
        statusCode: 409,
        data: {
          errors: [
            {
              message:
                "No skip cooldown callback ID found. The cooldown may have already completed.",
            },
          ],
        },
      });
    }

    const userEmail = getUserEmail(user);

    // Persist who skipped BEFORE resuming — the durable function reads
    // cooldownSkippedBy from the report when building the metric log.
    const reportKey = new CleanupReportKey(awsAccountId, report.startedAt);
    await cleanupReportStore.updateReport({
      key: reportKey,
      cooldownSkippedBy: userEmail,
    });

    const lambdaClient = IsbClients.lambda(env);
    await lambdaClient.send(
      new SendDurableExecutionCallbackSuccessCommand({
        CallbackId: report.skipCooldownCallbackId,
      }),
    );

    logger.info("CooldownSkipped", {
      accountId: awsAccountId,
      skippedBy: user.type === "user" ? user.userId : user.clientId,
      durableExecutionArn: report.durableExecutionArn,
    });

    return {
      status: JSendStatus.SUCCESS,
      data: { message: "Cooldown skipped successfully." },
    };
  };
}

/**
 * The `AccountsApi` service. Every operation is wrapped in `withDelegatedErrors`
 * so the 404/409/400 business errors render through the shared Middy
 * `httpErrorHandler` exactly as the pre-Smithy handler produced them.
 */
export function accountsService(
  logger: Logger,
): AccountsApiService<AccountsSmithyContext> {
  return {
    ListAccounts: withDelegatedErrors(listAccounts(logger)),
    GetAccount: withDelegatedErrors(getAccount(logger)),
    ListUnregisteredAccounts: withDelegatedErrors(
      listUnregisteredAccounts(logger),
    ),
    ListCleanupReports: withDelegatedErrors(listCleanupReports(logger)),
    RegisterAccount: withDelegatedErrors(registerAccount(logger)),
    EjectAccount: withDelegatedErrors(ejectAccount(logger)),
    QuarantineAccount: withDelegatedErrors(quarantineAccount(logger)),
    RetryCleanup: withDelegatedErrors(retryCleanup(logger)),
    SkipCooldown: withDelegatedErrors(skipCooldown(logger)),
  };
}
