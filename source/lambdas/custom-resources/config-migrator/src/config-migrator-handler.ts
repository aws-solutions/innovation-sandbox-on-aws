// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import {
  ListConfigurationProfilesCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-appconfig";
import {
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from "@aws-sdk/client-appconfigdata";
import type {
  CdkCustomResourceEvent,
  CdkCustomResourceResponse,
  Context,
} from "aws-lambda";
import yaml from "js-yaml";
import { z } from "zod";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  ConfigMigratorLambdaEnvironment,
  ConfigMigratorLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/config-migrator-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import {
  ConfigSchemas,
  ConfigSection,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

const tracer = new Tracer();
const logger = new Logger();

const MIGRATION_SENTINEL = "system:migration";

// Substrings of the CloudFormation-generated AppConfig profile names (derived
// from the CDK construct ids). The migrator has no profile IDs in its env — the
// profiles are deleted in the same deployment — so it discovers them by name.
// NukeConfig and ValidatorExclusionConfig are intentionally retained in
// AppConfig (design §4.4) and must NOT trigger a migration.
const GLOBAL_CONFIG_PROFILE_NAME_FRAGMENT = "GlobalConfigHostedConfiguration";
const REPORTING_CONFIG_PROFILE_NAME_FRAGMENT =
  "ReportingConfigHostedConfiguration";

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: ConfigMigratorLambdaEnvironmentSchema,
  moduleName: "config-migrator",
}).handler(lambdaHandler);

async function lambdaHandler(
  event: CdkCustomResourceEvent,
  context: Context & ValidatedEnvironment<ConfigMigratorLambdaEnvironment>,
): Promise<CdkCustomResourceResponse> {
  switch (event.RequestType) {
    case "Create":
    case "Update":
      // The migrator custom resource is introduced by the upgrade itself, so an
      // actual upgrade arrives as a Create (the resource has no prior physical
      // id) while an in-place redeploy of the new stack arrives as an Update.
      // Both run the migration; onUpdate's "GlobalConfig profile not found →
      // skip" check distinguishes a fresh install (no AppConfig profiles to
      // migrate) from an upgrade.
      return onUpdate(context.env);
    case "Delete":
      // The config table has a RETAIN removal policy; nothing to undo.
      logger.info("Delete event: retaining migrated configuration");
      return { Data: { status: "retained" } };
  }
}

async function onUpdate(
  env: ConfigMigratorLambdaEnvironment,
): Promise<CdkCustomResourceResponse> {
  // Destination-first idempotency: if config already exists in DynamoDB, skip
  // before reading/validating the (retained) AppConfig profiles. See design
  // doc section 5.3.
  const existingSections = await IsbServices.configStore(env).getAllSections();
  if (Object.keys(existingSections).length > 0) {
    logger.info(
      "Configuration already present in DynamoDB; skipping migration (no overwrite)",
    );
    return { Data: { status: "skipped" } };
  }

  const profiles = await listConfigurationProfiles(env);
  if (profiles === undefined) {
    // ResourceNotFoundException: the AppConfig application itself is gone
    // (fresh install or already-deleted), so there is nothing to migrate.
    logger.info("AppConfig application not found; skipping migration");
    return { Data: { status: "skipped" } };
  }

  const globalProfileId = findProfileId(
    profiles,
    GLOBAL_CONFIG_PROFILE_NAME_FRAGMENT,
  );
  if (globalProfileId === undefined) {
    // No source to migrate (fresh install). "Already migrated" is handled by
    // the destination-first check above.
    logger.info(
      "GlobalConfig AppConfig profile not found; nothing to migrate, skipping",
    );
    return { Data: { status: "skipped" } };
  }

  const reportingProfileId = findProfileId(
    profiles,
    REPORTING_CONFIG_PROFILE_NAME_FRAGMENT,
  );
  if (reportingProfileId === undefined) {
    // Global/Reporting profiles are created and deleted as a unit. One without
    // the other is an unexpected state; fail rather than write partial data.
    throw new Error(
      "GlobalConfig profile found but ReportingConfig profile is missing; cannot complete migration",
    );
  }

  const globalConfig = await readProfileYaml(env, globalProfileId);
  const reportingConfig = await readProfileYaml(env, reportingProfileId);

  const sectionFields: Record<ConfigSection, unknown> = {
    leases: pick(globalConfig, "leases"),
    cleanup: pick(globalConfig, "cleanup"),
    notification: pick(globalConfig, "notification"),
    maintenance: { enabled: pick(globalConfig, "maintenanceMode") },
    termsOfService: { content: pick(globalConfig, "termsOfService") },
    costReporting: reportingConfig,
    agent: {},
  };

  const validatedSections: {
    [K in ConfigSection]?: z.infer<(typeof ConfigSchemas)[K]>;
  } = {};
  for (const section of Object.keys(ConfigSchemas) as ConfigSection[]) {
    (validatedSections as Record<ConfigSection, unknown>)[section] =
      validateSection(section, sectionFields[section]);
  }

  // The store owns the key shape, audit envelope, and the conditional write.
  const { migrated } = await IsbServices.configStore(env).migrateSections(
    validatedSections,
    MIGRATION_SENTINEL,
  );

  if (!migrated) {
    // Conditional write rejected: a concurrent invocation migrated first. Skip
    // rather than overwrite.
    logger.info(
      "Configuration already migrated to DynamoDB; skipping (no overwrite)",
    );
    return { Data: { status: "skipped" } };
  }

  logger.info("Configuration migration complete", {
    sections: Object.keys(ConfigSchemas),
  });
  return { Data: { status: "migrated" } };
}

/**
 * Lists AppConfig configuration profiles for the application. Returns
 * `undefined` when the application does not exist (fresh install), in which case
 * the migrator skips.
 */
async function listConfigurationProfiles(
  env: ConfigMigratorLambdaEnvironment,
): Promise<{ Id?: string; Name?: string }[] | undefined> {
  const profiles: { Id?: string; Name?: string }[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const response = await IsbClients.appConfig(env).send(
        new ListConfigurationProfilesCommand({
          ApplicationId: env.APP_CONFIG_APPLICATION_ID,
          NextToken: nextToken,
        }),
      );
      profiles.push(...(response.Items ?? []));
      nextToken = response.NextToken;
    } while (nextToken);
  } catch (error: unknown) {
    if (error instanceof ResourceNotFoundException) {
      return undefined;
    }
    throw error;
  }
  return profiles;
}

function findProfileId(
  profiles: { Id?: string; Name?: string }[],
  nameFragment: string,
): string | undefined {
  return profiles.find((profile) => profile.Name?.includes(nameFragment))?.Id;
}

/**
 * Reads a profile's raw YAML configuration from AppConfig and returns the parsed
 * object. Reads the raw document (not via `GlobalConfigSchema`) so legacy fields
 * outside the new per-section schemas are dropped during section validation
 * rather than silently re-injected as defaults.
 */
async function readProfileYaml(
  env: ConfigMigratorLambdaEnvironment,
  profileId: string,
): Promise<Record<string, unknown>> {
  const session = await IsbClients.appConfigData(env).send(
    new StartConfigurationSessionCommand({
      ApplicationIdentifier: env.APP_CONFIG_APPLICATION_ID,
      EnvironmentIdentifier: env.APP_CONFIG_ENVIRONMENT_ID,
      ConfigurationProfileIdentifier: profileId,
    }),
  );

  const configuration = await IsbClients.appConfigData(env).send(
    new GetLatestConfigurationCommand({
      ConfigurationToken: session.InitialConfigurationToken,
    }),
  );

  if (!configuration.Configuration) {
    throw new Error(
      `AppConfig returned an empty configuration document for profile ${profileId}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(
      Buffer.from(configuration.Configuration).toString("utf8"),
    );
  } catch {
    // A js-yaml parse error embeds a snippet of the source document in its
    // message; surfacing it would leak raw configuration values into the
    // CloudFormation failure reason (threat model I-3.1). `profileId` is an
    // AppConfig UUID, not config content, so it is safe to include.
    throw new Error(
      `Configuration migration failed parsing AppConfig profile ${profileId}: invalid YAML`,
    );
  }

  // A syntactically valid but non-object document (scalar, null, empty/comment
  // only, or array) is not parseable into config sections. Reject it here with
  // a sanitized error rather than letting a later property access throw a raw,
  // unscoped TypeError.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Configuration migration failed parsing AppConfig profile ${profileId}: expected a YAML object`,
    );
  }

  return parsed as Record<string, unknown>;
}

/** Reads a top-level key from a parsed config object. */
function pick(config: Record<string, unknown>, key: string): unknown {
  return config[key];
}

/**
 * Narrows raw AppConfig fields to only the keys the section's schema defines.
 * Customer AppConfig can carry fields outside the new per-section schemas —
 * e.g. the discarded `auth` block. Dropping unknown keys here keeps strict
 * value-validation (bad values still fail the deploy) while tolerating schema
 * drift so an upgrade is not failed over a benign extra key. Returns the value
 * unchanged when it is not an object so the schema can produce a clean
 * validation error.
 */
function pickKnownFields(section: ConfigSection, fields: unknown): unknown {
  if (fields === null || typeof fields !== "object") {
    return fields;
  }
  const shape = (ConfigSchemas[section] as z.ZodObject<z.ZodRawShape>).shape;
  const source = fields as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    if (key in source) {
      picked[key] = source[key];
    }
  }
  return picked;
}

/**
 * Validates section fields against the section's read schema. The read schema
 * (`ConfigSchemas`) fills defaults for fields with no AppConfig source. On
 * failure, re-throws with the section name and field paths only — never the
 * raw configuration values (threat model I-3.1).
 */
function validateSection(section: ConfigSection, fields: unknown): object {
  const result = (ConfigSchemas[section] as z.ZodType).safeParse(
    pickKnownFields(section, fields),
  );
  if (!result.success) {
    const paths = result.error.issues
      .map((issue) => issue.path.join(".") || "(root)")
      .join(", ");
    throw new Error(
      `Configuration migration failed validating section "${section}": ${paths}`,
    );
  }
  return result.data as object;
}
