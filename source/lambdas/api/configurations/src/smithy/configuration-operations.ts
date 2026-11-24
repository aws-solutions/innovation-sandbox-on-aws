// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { GetIdentityVerificationAttributesCommand } from "@aws-sdk/client-ses";

import type { BedrockRegionalPrice } from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/bedrock-price-cache.js";
import {
  AgentModelUpsertBodySchema,
  PersistedAgentModelCatalogRow,
} from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import { ConflictError } from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import { PersistedConfigSectionData } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import {
  AgentModelNotEligibleError,
  LastEnabledModelError,
  ModelNotPricedError,
  SaveAgentModelCatalogEntryProps,
  getEnabledAgentModelIds,
  getStoredModelPrices,
  saveAgentModelCatalogEntry,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/index.js";
import { pickModelPricing } from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/index.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  candidateSesIdentities,
  isSenderAddressCoveredBySesIdentity,
  parseValidatedSesIdentityArn,
} from "@amzn/innovation-sandbox-commons/isb-services/notification/ses-identity.js";
import { ConfigurationLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import {
  createHttpJSendError,
  createHttpJSendValidationError,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { withDelegatedErrors } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";
import { parseRawJsonBody } from "@amzn/innovation-sandbox-commons/lambda/smithy/parse-raw-json-body.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { assertDefined } from "@amzn/innovation-sandbox-commons/utils/assertions.js";
import {
  ConfigPutBodySchemas,
  ConfigSchemas,
  ConfigSection,
  ConfigSectionFields,
  ConfigurationResponseMetadata,
  hasCompleteConfigurationResponseMetadata,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  getUserEmail,
  isM2MUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

import type {
  AgentModelCatalogEntry,
  ConfigurationsApiService,
  GetConfigurationsServerInput,
  GetConfigurationsServerOutput,
  ListAgentModelCatalogServerInput,
  PutAgentModelCatalogEntryServerInput,
  AdminConfiguration as SmithyAdminConfiguration,
  ConfigurationResponseMetadata as SmithyConfigurationResponseMetadata,
} from "@amzn/innovation-sandbox-api-server/configurations";
import { JSendStatus } from "@amzn/innovation-sandbox-api-server/configurations";

export type ConfigurationSmithyContext =
  IsbSmithyContext<ConfigurationLambdaEnvironment>;

type ConfigurationSectionOutput<T extends ConfigSection> =
  ConfigSectionFields<T> & {
    lastSavedBy: string | null;
    meta?: ConfigurationResponseMetadata;
  };

/**
 * Runs a read against the config/account-pool stores, logging which read failed
 * (with domain context) before rethrowing. The generated pipeline turns the
 * rethrown error into a 500; this line is what makes that 500 diagnosable — the
 * read path is otherwise silent (unlike the write path's SES/conflict logging).
 */
async function withReadContext<T>(
  logger: Logger,
  operation: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    logger.error(`configuration read failed: ${operation}`, {
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Adapts a persisted section into the generated Smithy output: fields pass through;
 * `meta` timestamps are opaque strings (byte-exact concurrency token); `schemaVersion`
 * is dropped and a null `lastSavedBy`/absent `meta` for a never-saved section. `meta`
 * is emitted only when both timestamps are present;
 * the store already rejects corrupt records, so this guard is defense-in-depth.
 */
function toConfigurationOutput<T extends ConfigSection>(
  section: ConfigurationSectionOutput<ConfigSection>,
  sectionName: T,
  logger: Logger,
): SmithyAdminConfiguration[T] {
  const { meta, lastSavedBy, ...fields } = section;
  const complete = hasCompleteConfigurationResponseMetadata(meta);
  if (meta && !complete) {
    logger.warn(
      `configuration section '${sectionName}' has incomplete meta; treating as unsaved`,
    );
  }
  const responseMeta = complete
    ? ({
        createdTime: meta.createdTime,
        lastEditTime: meta.lastEditTime,
      } satisfies SmithyConfigurationResponseMetadata)
    : undefined;
  return {
    ...fields,
    lastSavedBy: lastSavedBy ?? undefined,
    meta: responseMeta,
  } as unknown as SmithyAdminConfiguration[T];
}

/** The stored section, or its code defaults with a null `lastSavedBy` and no meta. */
function readSection(
  stored: PersistedConfigSectionData<ConfigSection> | undefined,
  section: ConfigSection,
): ConfigurationSectionOutput<ConfigSection> {
  return stored ?? { ...ConfigSchemas[section].parse({}), lastSavedBy: null };
}

// Sender field validated against SES and named in its 400 response.
const EMAIL_FROM_FIELD =
  "emailFrom" satisfies keyof PersistedConfigSectionData<"notification">;

const DELEGATED_EMAIL_IDENTITY_MESSAGE =
  "The email provided is not covered by the delegated SES identity for this deployment. Use the delegated identity's exact address.";
const DELEGATED_DOMAIN_IDENTITY_MESSAGE =
  "The email provided is not covered by the delegated SES identity for this deployment. Use an address in that identity's domain or one of its subdomains.";
const EMAIL_FROM_NOT_VERIFIED_MESSAGE =
  "The email provided is not a verified SES identity in this account. Verify the address or its domain in Amazon SES before saving.";
const SES_VERIFICATION_UNAVAILABLE_MESSAGE =
  "Unable to verify this email against SES. Please try again shortly.";

type EmailFromCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

const EMAIL_FROM_OK: EmailFromCheck = { ok: true };

/**
 * Checks a sender locally for a delegated identity, or through SES for a hub
 * identity. SES query failures are rejected so an unverified sender is not stored.
 */
async function checkEmailFromSendable(
  logger: Logger,
  emailFrom: string,
  env: ConfigurationLambdaEnvironment,
): Promise<EmailFromCheck> {
  if (env.SES_IDENTITY_ARN) {
    const identity = parseValidatedSesIdentityArn(env.SES_IDENTITY_ARN);
    if (isSenderAddressCoveredBySesIdentity(identity, emailFrom)) {
      return EMAIL_FROM_OK;
    }
    return {
      ok: false,
      message:
        identity.kind === "email"
          ? DELEGATED_EMAIL_IDENTITY_MESSAGE
          : DELEGATED_DOMAIN_IDENTITY_MESSAGE,
    };
  }

  const identities = candidateSesIdentities(emailFrom);
  let verificationAttributes: Record<string, { VerificationStatus?: string }>;
  try {
    const sesClient = IsbClients.ses(env);
    const response = await sesClient.send(
      new GetIdentityVerificationAttributesCommand({ Identities: identities }),
    );
    verificationAttributes = response.VerificationAttributes ?? {};
  } catch (error: unknown) {
    const statusCode = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    const message = error instanceof Error ? error.message : String(error);
    // Log the domain only, never the full address: `emailFrom` is modeled
    // `@sensitive` (redacted on the wire), so it must not appear in cleartext in
    // CloudWatch either. The domain is what a responder needs to know which SES
    // identity failed.
    const emailDomain = emailFrom.includes("@")
      ? emailFrom.slice(emailFrom.lastIndexOf("@") + 1)
      : "<redacted>";
    if (statusCode && statusCode < 500) {
      logger.error(
        "SES identity check denied — possible IAM misconfiguration",
        { emailDomain, error: message },
      );
    } else {
      logger.warn("SES identity check failed", { emailDomain, error: message });
    }
    return { ok: false, message: SES_VERIFICATION_UNAVAILABLE_MESSAGE };
  }

  const verified = identities.some(
    (id) => verificationAttributes[id]?.VerificationStatus === "Success",
  );
  return verified
    ? EMAIL_FROM_OK
    : { ok: false, message: EMAIL_FROM_NOT_VERIFIED_MESSAGE };
}

/** Creates the static 400 field error for an unusable sender. */
function emailFromValidationError(message: string) {
  return createHttpJSendError({
    statusCode: 400,
    data: { errors: [{ field: EMAIL_FROM_FIELD, message }] },
  });
}

/**
 * `GET /configurations` — every section (stored or code-default) plus the
 * deploy-time fields resolved outside the config store.
 */
function getConfigurations(logger: Logger) {
  return async (
    _input: GetConfigurationsServerInput,
    context: ConfigurationSmithyContext,
  ): Promise<GetConfigurationsServerOutput> => {
    const { env } = context.lambdaContext;

    // Wrap the store reads so a DynamoDB/SSM failure is logged with which read
    // failed before it becomes an undifferentiated 500 downstream.
    const storedSections = await withReadContext(
      logger,
      "getConfigurations:getAllSections",
      () => IsbServices.configStore(env).getAllSections(),
    );

    // Keep the aggregate mapping explicit so generated Smithy member changes
    // fail here instead of being hidden by a string-indexed loop.
    const sections = {
      leases: toConfigurationOutput(
        readSection(storedSections.leases, "leases"),
        "leases",
        logger,
      ),
      cleanup: toConfigurationOutput(
        readSection(storedSections.cleanup, "cleanup"),
        "cleanup",
        logger,
      ),
      notification: toConfigurationOutput(
        readSection(storedSections.notification, "notification"),
        "notification",
        logger,
      ),
      maintenance: toConfigurationOutput(
        readSection(storedSections.maintenance, "maintenance"),
        "maintenance",
        logger,
      ),
      termsOfService: toConfigurationOutput(
        readSection(storedSections.termsOfService, "termsOfService"),
        "termsOfService",
        logger,
      ),
      costReporting: toConfigurationOutput(
        readSection(storedSections.costReporting, "costReporting"),
        "costReporting",
        logger,
      ),
      agent: toConfigurationOutput(
        readSection(storedSections.agent, "agent"),
        "agent",
        logger,
      ),
    } satisfies Pick<SmithyAdminConfiguration, ConfigSection>;

    const { isbManagedRegions, bedrockInferenceProfilePatterns } =
      await withReadContext(logger, "getConfigurations:accountPoolConfig", () =>
        IsbServices.accountPoolStackConfigStore(env).get(),
      );

    const data = {
      ...sections,
      isbManagedRegions,
      awsAccessPortalUrl: env.AWS_ACCESS_PORTAL_URL,
      bedrockInferenceProfilePatterns: (bedrockInferenceProfilePatterns ?? "")
        .split(",")
        .map((pattern) => pattern.trim())
        .filter(Boolean),
    } satisfies SmithyAdminConfiguration;

    return {
      status: JSendStatus.SUCCESS,
      data,
    };
  };
}

/** `GET /configurations/{section}` for one section (literal path). */
function getSection(logger: Logger, section: ConfigSection) {
  return async (_input: unknown, context: ConfigurationSmithyContext) => {
    const { env } = context.lambdaContext;
    const stored = await withReadContext(logger, `getSection:${section}`, () =>
      IsbServices.configStore(env).getSection(section),
    );
    return {
      status: JSendStatus.SUCCESS,
      data: toConfigurationOutput(
        readSection(stored ?? undefined, section),
        section,
        logger,
      ),
    };
  };
}

/** `PUT /configurations/{section}` for one section (literal path). */
function updateSection(logger: Logger, section: ConfigSection) {
  return async (_input: unknown, context: ConfigurationSmithyContext) => {
    const { event, lambdaContext } = context;
    const { env, user } = lambdaContext;

    // Defense-in-depth backstop: `rejectM2mConfigWrites` already rejects M2M
    // writes before the pipeline (ahead of model validation), so this normally
    // never runs — it guards against a future handler-wiring change that drops
    // that middleware. Admin-only is enforced by the RBAC map.
    assertHumanCaller(user);

    // Model validation (required/range/length/enum/type) already ran; this Zod
    // re-parse of the raw body is the sole owner of what the model cannot express
    // — `strict` unknown-key rejection, the `leases` cross-field rule, and the
    // request audit envelope — exactly as the Lease Templates domain does.
    const parseResult = ConfigPutBodySchemas[section].safeParse(
      parseRawJsonBody(event),
    );
    if (!parseResult.success) {
      throw createHttpJSendValidationError(parseResult.error);
    }

    const {
      meta,
      lastSavedBy: _lastSavedBy,
      ...fields
    } = parseResult.data as {
      meta?: { lastEditTime?: string };
      lastSavedBy?: unknown;
      [field: string]: unknown;
    };
    const expectedLastEditTime = meta?.lastEditTime;

    // Check non-empty senders even while SES is off, before storing them.
    if (
      section === "notification" &&
      typeof fields[EMAIL_FROM_FIELD] === "string" &&
      fields[EMAIL_FROM_FIELD] !== ""
    ) {
      const check = await checkEmailFromSendable(
        logger,
        fields[EMAIL_FROM_FIELD],
        env,
      );
      if (!check.ok) {
        throw emailFromValidationError(check.message);
      }
    }

    // Sandbox Spaces inference runs in the hub home region, which aws-nuke only
    // cleans when it is managed. Refuse to enable it from an unmanaged region.
    if (section === "agent" && fields.sandboxSpacesEnabled === true) {
      const { isbManagedRegions } = await withReadContext(
        logger,
        "updateSection:accountPoolConfig",
        () => IsbServices.accountPoolStackConfigStore(env).get(),
      );
      if (!isbManagedRegions.includes(env.AWS_REGION)) {
        throw createHttpJSendError({
          statusCode: 400,
          data: {
            errors: [
              {
                field: "sandboxSpacesEnabled",
                message:
                  `Sandbox Spaces requires the hub home region (${env.AWS_REGION}) ` +
                  "to be an ISB-managed region. Add it to the ISB-managed regions.",
              },
            ],
          },
        });
      }

      const enabledModelIds = await withReadContext(
        logger,
        "updateSection:enabledAgentModels",
        () =>
          // A model saved just before this request must count.
          getEnabledAgentModelIds(
            { configStore: IsbServices.configStore(env) },
            { consistentRead: true },
          ),
      );
      if (enabledModelIds.length === 0) {
        throw createHttpJSendError({
          statusCode: 400,
          data: {
            errors: [
              {
                field: "sandboxSpacesEnabled",
                message:
                  "Enable at least one model in the Model Catalog before you turn on Sandbox Spaces.",
              },
            ],
          },
        });
      }
    }

    try {
      const data = await IsbServices.configStore(env).putSection(
        section,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fields as any,
        getUserEmail(user),
        expectedLastEditTime,
      );
      return {
        status: JSendStatus.SUCCESS,
        data: toConfigurationOutput(data, section, logger),
      };
    } catch (error) {
      if (error instanceof ConflictError) {
        throw createHttpJSendError({
          statusCode: 409,
          data: {
            errors: [
              {
                message:
                  "Configuration was modified by another administrator. Reload to see the latest values.",
              },
            ],
          },
        });
      }
      throw error;
    }
  };
}

/**
 * Throws 403 if the caller is an M2M service account. Used by all catalog
 * write handlers — the audit trail requires a human email identity.
 * Defense-in-depth: `rejectM2mConfigWrites` middleware already blocks M2M
 * before the pipeline; this guard covers future wiring changes.
 */
function assertHumanCaller(user: Parameters<typeof isM2MUser>[0]): void {
  if (isM2MUser(user)) {
    throw createHttpJSendError({
      statusCode: 403,
      data: {
        errors: [
          { message: "User is not authorized to update configuration." },
        ],
      },
    });
  }
}

/**
 * `GET /configurations/agent/models` — returns a page of catalog rows.
 * Supports nextToken/maxResults for pagination; no nextToken in response
 * means the last page was returned.
 *
 * Each row is returned with its price from the Bedrock regional price table,
 * as the catalog rows hold none. A model with no stored price has no price
 * fields.
 */
function getAgentModelCatalog(logger: Logger) {
  return async (
    input: ListAgentModelCatalogServerInput,
    context: ConfigurationSmithyContext,
  ) => {
    const { env } = context.lambdaContext;
    const { rows, nextPageIdentifier } = await withReadContext(
      logger,
      "getAgentModels",
      () =>
        IsbServices.configStore(env).getAgentModelsPaginated({
          pageSize: input.maxResults ?? undefined,
          pageIdentifier: input.nextToken ?? undefined,
        }),
    );
    const prices = await getStoredModelPrices(
      { modelIds: rows.map(({ modelId }) => modelId), region: currentRegion() },
      { priceCache: IsbServices.bedrockPriceCache(env) },
    );
    return {
      status: JSendStatus.SUCCESS,
      data: {
        models: rows.map((row) =>
          toAgentModelCatalogEntry(row, prices.get(row.modelId)),
        ),
        ...(nextPageIdentifier ? { nextToken: nextPageIdentifier } : {}),
      },
    };
  };
}

/** The region this Lambda runs in, which is the region its prices are stored under. */
function currentRegion(): string {
  const region = process.env["AWS_REGION"];
  if (!region) {
    throw new Error("AWS_REGION is not set");
  }
  return region;
}

/**
 * `PUT /configurations/agent/models/{modelId}` — create or toggle.
 * No `expectedLastEditTime`: looks the model up in Bedrock as `modelType`,
 * then creates the row from Bedrock's canonical metadata.
 * With `expectedLastEditTime`: OCC-guarded update of the enabled state only.
 */
function putAgentModelCatalogEntry(logger: Logger) {
  return async (
    input: PutAgentModelCatalogEntryServerInput,
    context: ConfigurationSmithyContext,
  ) => {
    const { event, lambdaContext } = context;
    const { env, user } = lambdaContext;

    assertHumanCaller(user);

    const body = parseRawJsonBody(event) as Record<string, unknown>;
    const parseResult = AgentModelUpsertBodySchema.safeParse(body);
    if (!parseResult.success) {
      throw createHttpJSendValidationError(parseResult.error);
    }

    const { enabled, expectedLastEditTime, modelType } = parseResult.data;
    const entry: SaveAgentModelCatalogEntryProps["entry"] = expectedLastEditTime
      ? {
          kind: "update",
          modelId: input.modelId,
          enabled,
          expectedLastEditTime,
        }
      : {
          kind: "create",
          modelId: input.modelId,
          enabled,
          // AgentModelUpsertBodySchema requires modelType on create.
          modelType: assertDefined(
            modelType,
            "modelType is required when creating a catalog entry",
          ),
        };
    try {
      const { row, price } = await saveAgentModelCatalogEntry(
        { entry, editedBy: getUserEmail(user), region: currentRegion() },
        {
          configStore: IsbServices.configStore(env),
          priceCache: IsbServices.bedrockPriceCache(env),
          bedrockClient: IsbClients.bedrock(env),
          logger,
        },
      );
      logger.info("Agent model catalog entry put", {
        modelId: input.modelId,
        enabled,
        isCreate: !expectedLastEditTime,
      });
      return {
        status: JSendStatus.SUCCESS,
        data: toAgentModelCatalogEntry(row, price),
      };
    } catch (error) {
      if (error instanceof AgentModelNotEligibleError) {
        throw createHttpJSendError({
          statusCode: 400,
          data: {
            errors: [{ field: "modelId", message: error.message }],
          },
        });
      }
      if (error instanceof LastEnabledModelError) {
        throw createHttpJSendError({
          statusCode: 400,
          data: {
            errors: [{ field: "enabled", message: error.message }],
          },
        });
      }
      if (error instanceof ModelNotPricedError) {
        throw createHttpJSendError({
          statusCode: 409,
          data: {
            errors: [{ message: error.message }],
          },
        });
      }
      if (error instanceof ConflictError) {
        throw createHttpJSendError({
          statusCode: 409,
          data: {
            errors: [{ message: "Reload the model list and try again." }],
          },
        });
      }
      throw error;
    }
  };
}

/**
 * Explicitly projects `PersistedAgentModelCatalogRow` onto the modeled
 * `AgentModelCatalogEntry` shape, adding the model's stored price when there
 * is one and shaping `meta` to `{ createdTime, lastEditTime }` — matching the
 * pattern of `toConfigurationOutput` which strips `schemaVersion` from meta.
 */
function toAgentModelCatalogEntry(
  row: PersistedAgentModelCatalogRow,
  price?: BedrockRegionalPrice,
): AgentModelCatalogEntry {
  return {
    modelId: row.modelId,
    displayName: row.displayName,
    provider: row.provider,
    availability: row.availability,
    description: row.description,
    modelType: row.modelType,
    foundationModelId: row.foundationModelId,
    foundationModelName: row.foundationModelName,
    ...(price
      ? {
          ...pickModelPricing(price),
          pricingRefreshedAt: price.pricingRefreshedAt,
        }
      : {}),
    enabled: row.enabled,
    addedAt: row.addedAt,
    lastSavedBy: row.lastSavedBy,
    meta: {
      createdTime: row.meta.createdTime,
      lastEditTime: row.meta.lastEditTime,
    },
  };
}

/**
 * The `ConfigurationsApi` service. `GetConfigurations` plus a read and a write per
 * configured section (all on literal paths). The per-section read/write operations
 * are structurally identical, so they are built from `getSection`/`updateSection`
 * factories keyed by section; the object is asserted to the generated interface
 * because those factories return one shared shape rather than each operation's
 * distinct generated types.
 */
export function configurationService(
  logger: Logger,
): ConfigurationsApiService<ConfigurationSmithyContext> {
  return {
    GetConfigurations: withDelegatedErrors(getConfigurations(logger)),
    GetLeasesConfiguration: withDelegatedErrors(getSection(logger, "leases")),
    UpdateLeasesConfiguration: withDelegatedErrors(
      updateSection(logger, "leases"),
    ),
    GetCleanupConfiguration: withDelegatedErrors(getSection(logger, "cleanup")),
    UpdateCleanupConfiguration: withDelegatedErrors(
      updateSection(logger, "cleanup"),
    ),
    GetNotificationConfiguration: withDelegatedErrors(
      getSection(logger, "notification"),
    ),
    UpdateNotificationConfiguration: withDelegatedErrors(
      updateSection(logger, "notification"),
    ),
    GetMaintenanceConfiguration: withDelegatedErrors(
      getSection(logger, "maintenance"),
    ),
    UpdateMaintenanceConfiguration: withDelegatedErrors(
      updateSection(logger, "maintenance"),
    ),
    GetTermsOfServiceConfiguration: withDelegatedErrors(
      getSection(logger, "termsOfService"),
    ),
    UpdateTermsOfServiceConfiguration: withDelegatedErrors(
      updateSection(logger, "termsOfService"),
    ),
    GetCostReportingConfiguration: withDelegatedErrors(
      getSection(logger, "costReporting"),
    ),
    UpdateCostReportingConfiguration: withDelegatedErrors(
      updateSection(logger, "costReporting"),
    ),
    GetAgentConfiguration: withDelegatedErrors(getSection(logger, "agent")),
    UpdateAgentConfiguration: withDelegatedErrors(
      updateSection(logger, "agent"),
    ),
    ListAgentModelCatalog: withDelegatedErrors(getAgentModelCatalog(logger)),
    PutAgentModelCatalogEntry: withDelegatedErrors(
      putAgentModelCatalogEntry(logger),
    ),
  } as unknown as ConfigurationsApiService<ConfigurationSmithyContext>;
}
