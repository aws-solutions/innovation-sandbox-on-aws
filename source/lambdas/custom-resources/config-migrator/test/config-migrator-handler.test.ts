// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  AppConfigClient,
  ListConfigurationProfilesCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-appconfig";
import {
  AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from "@aws-sdk/client-appconfigdata";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { CdkCustomResourceEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import yaml from "js-yaml";
import { beforeEach, describe, expect, it } from "vitest";

import { ConfigSchemaVersion } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { ConfigMigratorLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-migrator-lambda-environment.js";
import { EnvironmentValidatorError } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { handler } from "@amzn/innovation-sandbox-config-migrator/config-migrator-handler.js";
import {
  ConfigSchemas,
  ConfigSection,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

const testEnv = generateSchemaData(ConfigMigratorLambdaEnvironmentSchema, {
  APP_CONFIG_APPLICATION_ID: "test-application-id",
  APP_CONFIG_ENVIRONMENT_ID: "test-environment-id",
  CONFIG_TABLE_NAME: "test-config-table",
});

const appConfigMock = mockClient(AppConfigClient);
const appConfigDataMock = mockClient(AppConfigDataClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const GLOBAL_PROFILE_ID = "global-profile-id";
const REPORTING_PROFILE_ID = "reporting-profile-id";

// Profile names mirror the CloudFormation-generated names in the Data Stack
// snapshot. Only Global/Reporting are migrated; Nuke and ValidatorExclusion are
// retained in AppConfig and must be ignored by the decision signal.
const NUKE_PROFILE = {
  Id: "nuke-profile-id",
  Name: "IsbDataStack-Config-NukeConfigHostedConfiguration-E4A1CA34",
};
const VALIDATOR_PROFILE = {
  Id: "validator-profile-id",
  Name: "IsbDataStack-Config-ValidatorExclusionConfigHostedConfiguration-4B78B936",
};
const GLOBAL_PROFILE = {
  Id: GLOBAL_PROFILE_ID,
  Name: "IsbDataStack-Config-GlobalConfigHostedConfiguration-74548BD0",
};
const REPORTING_PROFILE = {
  Id: REPORTING_PROFILE_ID,
  Name: "IsbDataStack-Config-ReportingConfigHostedConfiguration-03483A30",
};

const ALL_SECTION_KEYS = [
  "leases",
  "cleanup",
  "notification",
  "maintenance",
  "termsOfService",
  "costReporting",
  "agent",
];

function validGlobalConfig() {
  return {
    maintenanceMode: true,
    termsOfService: "Test terms of service",
    leases: {
      requireMaxBudget: true,
      maxBudget: 50,
      requireMaxDuration: true,
      maxDurationHours: 168,
      maxLeasesPerUser: 3,
      ttl: 30,
      leaseSharingEnabled: false,
      allowUserLeaseTermination: true,
      leaseRequestWindowHours: 168,
      maxLeaseRequestsPerWindow: 10,
      enablePrincipalSearch: true,
    },
    cleanup: {
      numberOfFailedAttemptsToCancelCleanup: 3,
      waitBeforeRetryFailedAttemptSeconds: 5,
      numberOfSuccessfulAttemptsToFinishCleanup: 2,
      waitBeforeRerunSuccessfulAttemptSeconds: 30,
    },
    notification: {
      emailFrom: "admin@example.com",
    },
  };
}

function validReportingConfig() {
  return {
    costReportGroups: ["team-a"],
    requireCostReportGroup: true,
  };
}

function encodeConfig(config: unknown): Uint8Array {
  return new TextEncoder().encode(yaml.dump(config));
}

/**
 * Wires the AppConfig + AppConfigData mocks so the migrator can discover and
 * read the named profiles. `profiles` controls the ListConfigurationProfiles
 * result; `contents` maps profile id to the raw YAML config returned by
 * GetLatestConfiguration.
 */
function mockAppConfig(props: {
  profiles: { Id: string; Name: string }[];
  contents?: Record<string, unknown>;
  // Raw GetLatestConfiguration responses keyed by profile id, for cases that
  // need an empty or malformed document instead of a dumped object.
  rawContents?: Record<string, { Configuration?: Uint8Array }>;
}) {
  appConfigMock
    .on(ListConfigurationProfilesCommand)
    .resolves({ Items: props.profiles });

  appConfigDataMock.on(StartConfigurationSessionCommand).callsFake((input) => ({
    InitialConfigurationToken: `token-${input.ConfigurationProfileIdentifier}`,
  }));

  appConfigDataMock.on(GetLatestConfigurationCommand).callsFake((input) => {
    const profileId = String(input.ConfigurationToken).replace("token-", "");
    if (props.rawContents && profileId in props.rawContents) {
      return props.rawContents[profileId];
    }
    return { Configuration: encodeConfig(props.contents?.[profileId]) };
  });
}

function createEvent(
  requestType: "Create" | "Update" | "Delete",
): CdkCustomResourceEvent {
  return {
    RequestType: requestType as any,
    ServiceToken:
      "arn:aws:lambda:us-east-1:111111111111:function:CustomResourceProvider",
    ResponseURL: "https://example.com",
    StackId: "Stack",
    RequestId: "Request",
    LogicalResourceId: "ConfigMigratorCustomResource",
    PhysicalResourceId: "test-resource",
    ResourceType: "Custom::ConfigMigrator",
    ResourceProperties: {
      ServiceToken:
        "arn:aws:lambda:us-east-1:111111111111:function:CustomResourceProvider",
    },
  } as CdkCustomResourceEvent;
}

/**
 * Builds a valid stored DynamoDB config item so `getAllSections()` (the
 * migrator's destination-first idempotency check) returns a populated section.
 */
function buildStoredSection(section: ConfigSection): Record<string, unknown> {
  return {
    section,
    sk: "current",
    ...ConfigSchemas[section].parse({}),
    lastSavedBy: "admin@example.com",
    meta: {
      createdTime: "2024-06-01T12:00:00.000Z",
      lastEditTime: "2024-06-01T12:00:00.000Z",
      schemaVersion: ConfigSchemaVersion,
    },
  };
}

beforeEach(() => {
  bulkStubEnv(testEnv);
  appConfigMock.reset();
  appConfigDataMock.reset();
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  // Destination-first idempotency check reads DynamoDB via BatchGet; default to
  // an empty destination so the migrator proceeds. Cases that assert the
  // "already migrated" skip override this per-test.
  ddbMock.on(BatchGetCommand).resolves({ Responses: {} });
});

describe("Config Migrator Handler", () => {
  describe("Environment Validation", () => {
    it("throws when environment variables are misconfigured", async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { vi } = await import("vitest");
      vi.unstubAllEnvs();
      await expect(
        handler(createEvent("Create"), mockContext(testEnv)),
      ).rejects.toThrow(EnvironmentValidatorError);
    });
  });

  describe.each([
    { requestType: "Create" },
    { requestType: "Update" },
  ] as const)("$requestType Operations", ({ requestType }) => {
    it("skips when the GlobalConfig profile does not exist (fresh install)", async () => {
      // A fresh install of the new stack never creates the Global/Reporting
      // AppConfig profiles, so only Nuke + ValidatorExclusion exist. The
      // GlobalConfig-not-found check — not the event type — distinguishes a
      // fresh install from an upgrade, on both Create and Update.
      mockAppConfig({
        profiles: [NUKE_PROFILE, VALIDATOR_PROFILE],
        contents: {},
      });

      const response = await handler(
        createEvent(requestType),
        mockContext(testEnv),
      );

      expect(response.Data?.status).toBe("skipped");
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it("skips before reading AppConfig when the config already exists in DynamoDB", async () => {
      // Destination-first idempotency (the core of the fix): if DynamoDB
      // already holds config, the migrator must skip WITHOUT reading or
      // re-validating the retained AppConfig profiles. Re-validating that
      // frozen document on every future deploy would let a later schema
      // change permanently block the stack update even though the admin-saved
      // config is already in DynamoDB.
      ddbMock.on(BatchGetCommand).resolves({
        Responses: {
          [testEnv.CONFIG_TABLE_NAME]: [buildStoredSection("leases")],
        },
      });

      const response = await handler(
        createEvent(requestType),
        mockContext(testEnv),
      );

      expect(response.Data?.status).toBe("skipped");
      // Source AppConfig is never touched once the destination is populated.
      expect(appConfigMock.calls()).toHaveLength(0);
      expect(appConfigDataMock.calls()).toHaveLength(0);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it("skips without overwriting when a concurrent invocation already wrote the sections", async () => {
      // Defense-in-depth backstop for a race: DynamoDB is empty at the
      // destination-first check (BatchGet default is empty), so the migrator
      // reads the retained Global/Reporting profiles and attempts the write —
      // but a concurrent invocation populated the sections first, so the
      // conditional write is rejected. That must be treated as a no-op skip
      // rather than re-migrating over admin edits.
      mockAppConfig({
        profiles: [
          NUKE_PROFILE,
          GLOBAL_PROFILE,
          REPORTING_PROFILE,
          VALIDATOR_PROFILE,
        ],
        contents: {
          [GLOBAL_PROFILE_ID]: validGlobalConfig(),
          [REPORTING_PROFILE_ID]: validReportingConfig(),
        },
      });
      ddbMock.on(TransactWriteCommand).rejects(
        new TransactionCanceledException({
          message: "Transaction cancelled",
          $metadata: {},
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
        }),
      );

      const response = await handler(
        createEvent(requestType),
        mockContext(testEnv),
      );

      expect(response.Data?.status).toBe("skipped");
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    });

    it("migrates all seven sections atomically with the migration sentinel", async () => {
      mockAppConfig({
        profiles: [
          NUKE_PROFILE,
          GLOBAL_PROFILE,
          REPORTING_PROFILE,
          VALIDATOR_PROFILE,
        ],
        contents: {
          [GLOBAL_PROFILE_ID]: validGlobalConfig(),
          [REPORTING_PROFILE_ID]: validReportingConfig(),
        },
      });

      const response = await handler(
        createEvent(requestType),
        mockContext(testEnv),
      );

      expect(response.Data?.status).toBe("migrated");

      const transactCalls = ddbMock.commandCalls(TransactWriteCommand);
      expect(transactCalls).toHaveLength(1);

      const transactItems = transactCalls[0]?.args[0].input.TransactItems ?? [];
      expect(transactItems).toHaveLength(7);

      const items = transactItems.map((t: any) => t.Put.Item);
      const bySection: Record<string, any> = Object.fromEntries(
        items.map((i: any) => [i.section, i]),
      );

      expect(Object.keys(bySection).sort()).toEqual(
        [...ALL_SECTION_KEYS].sort(),
      );

      for (const item of items) {
        expect(item.sk).toBe("current");
        expect(item.lastSavedBy).toBe("system:migration");
        expect(item.meta.schemaVersion).toBe(ConfigSchemaVersion);
        expect(typeof item.meta.createdTime).toBe("string");
        expect(typeof item.meta.lastEditTime).toBe("string");
      }

      // Field/transform mapping per design §5.3 section-mapping table.
      expect(bySection.leases.maxBudget).toBe(50);
      expect(bySection.leases.enablePrincipalSearch).toBe(true);
      expect(bySection.cleanup.numberOfFailedAttemptsToCancelCleanup).toBe(3);
      expect(bySection.notification.emailFrom).toBe("admin@example.com");
      // The channel toggles have no legacy AppConfig source; the section's
      // `.default()`s apply, matching pre-feature behavior (SES on, SNS off).
      expect(bySection.notification.sesEnabled).toBe(true);
      expect(bySection.notification.snsIntegrationTopicEnabled).toBe(false);
      expect(bySection.maintenance.enabled).toBe(true);
      expect(bySection.termsOfService.content).toBe("Test terms of service");
      expect(bySection.costReporting.costReportGroups).toEqual(["team-a"]);
      expect(bySection.costReporting.requireCostReportGroup).toBe(true);

      // All items go to the configured table.
      for (const t of transactItems as any[]) {
        expect(t.Put.TableName).toBe(testEnv.CONFIG_TABLE_NAME);
      }
    });

    it("migrates the legacy cleanup validation/cooldown/retention fields", async () => {
      const globalConfig = validGlobalConfig();
      // Fields a customer's live AppConfig carries that the section
      // CleanupConfigSchema now also defines — they must migrate faithfully.
      (globalConfig.cleanup as Record<string, unknown>).cooldownPeriodHours =
        12;
      (globalConfig.cleanup as Record<string, unknown>).reportRetentionDays =
        365;
      (globalConfig.cleanup as Record<string, unknown>).validation = {
        failureAction: "Warn",
        delayAfterCleanupSeconds: 600,
      };

      mockAppConfig({
        profiles: [GLOBAL_PROFILE, REPORTING_PROFILE],
        contents: {
          [GLOBAL_PROFILE_ID]: globalConfig,
          [REPORTING_PROFILE_ID]: validReportingConfig(),
        },
      });

      await handler(createEvent(requestType), mockContext(testEnv));

      const transactItems =
        ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input
          .TransactItems ?? [];
      const cleanup = transactItems
        .map((t: any) => t.Put.Item)
        .find((i: any) => i.section === "cleanup");

      expect(cleanup.cooldownPeriodHours).toBe(12);
      expect(cleanup.reportRetentionDays).toBe(365);
      expect(cleanup.validation).toEqual({
        failureAction: "Warn",
      });
    });

    it("applies cleanup defaults when the legacy fields are absent", async () => {
      const globalConfig = validGlobalConfig();
      // A legacy AppConfig blob with no validation/cooldown/retention keys.
      delete (globalConfig.cleanup as Record<string, unknown>)
        .cooldownPeriodHours;
      delete (globalConfig.cleanup as Record<string, unknown>)
        .reportRetentionDays;
      delete (globalConfig.cleanup as Record<string, unknown>).validation;

      mockAppConfig({
        profiles: [GLOBAL_PROFILE, REPORTING_PROFILE],
        contents: {
          [GLOBAL_PROFILE_ID]: globalConfig,
          [REPORTING_PROFILE_ID]: validReportingConfig(),
        },
      });

      await handler(createEvent(requestType), mockContext(testEnv));

      const transactItems =
        ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input
          .TransactItems ?? [];
      const cleanup = transactItems
        .map((t: any) => t.Put.Item)
        .find((i: any) => i.section === "cleanup");

      // Fields with no AppConfig source pick up the schema defaults. Note the
      // cooldown default is 24h, so existing deployments that never set it get
      // a 24h cooldown on migration (not 0/disabled).
      expect(cleanup.cooldownPeriodHours).toBe(24);
      expect(cleanup.reportRetentionDays).toBe(730);
      expect(cleanup.validation).toEqual({
        failureAction: "Silent",
      });
    });

    it("fails with a sanitized message when a section fails Zod validation", async () => {
      const globalConfig = validGlobalConfig();
      globalConfig.leases.maxBudget = -99999; // violates gte(0)

      mockAppConfig({
        profiles: [GLOBAL_PROFILE, REPORTING_PROFILE],
        contents: {
          [GLOBAL_PROFILE_ID]: globalConfig,
          [REPORTING_PROFILE_ID]: validReportingConfig(),
        },
      });

      const promise = handler(createEvent(requestType), mockContext(testEnv));
      await expect(promise).rejects.toThrow();

      const error = await promise.catch((e: Error) => e);
      // Identifies the failing section and field path...
      expect(error.message).toContain("leases");
      expect(error.message).toContain("maxBudget");
      // ...but never echoes the raw configuration value (threat I-3.1).
      expect(error.message).not.toContain("99999");

      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it("fails when TransactWriteItems is cancelled", async () => {
      mockAppConfig({
        profiles: [GLOBAL_PROFILE, REPORTING_PROFILE],
        contents: {
          [GLOBAL_PROFILE_ID]: validGlobalConfig(),
          [REPORTING_PROFILE_ID]: validReportingConfig(),
        },
      });
      ddbMock.on(TransactWriteCommand).rejects(
        new TransactionCanceledException({
          message: "Transaction cancelled",
          $metadata: {},
        }),
      );

      await expect(
        handler(createEvent(requestType), mockContext(testEnv)),
      ).rejects.toThrow();
    });

    it("skips when ListConfigurationProfiles reports the application is missing", async () => {
      appConfigMock.on(ListConfigurationProfilesCommand).rejects(
        new ResourceNotFoundException({
          message: "Application not found",
          $metadata: {},
        }),
      );

      const response = await handler(
        createEvent(requestType),
        mockContext(testEnv),
      );

      expect(response.Data?.status).toBe("skipped");
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it("fails when GlobalConfig exists but ReportingConfig profile is missing", async () => {
      // global+reporting are created/deleted as a unit; one without the other
      // is an unexpected state, so fail rather than silently default.
      mockAppConfig({
        profiles: [GLOBAL_PROFILE],
        contents: { [GLOBAL_PROFILE_ID]: validGlobalConfig() },
      });

      await expect(
        handler(createEvent(requestType), mockContext(testEnv)),
      ).rejects.toThrow();
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it("fails when a profile returns an empty configuration document", async () => {
      mockAppConfig({
        profiles: [GLOBAL_PROFILE, REPORTING_PROFILE],
        rawContents: { [GLOBAL_PROFILE_ID]: { Configuration: undefined } },
        contents: { [REPORTING_PROFILE_ID]: validReportingConfig() },
      });

      await expect(
        handler(createEvent(requestType), mockContext(testEnv)),
      ).rejects.toThrow();
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it("fails when a profile parses to a non-object document", async () => {
      // Valid YAML, but a scalar — not parseable into config sections. Must
      // fail cleanly rather than throw a raw TypeError on property access.
      const scalarDoc = new TextEncoder().encode("just a string\n");
      mockAppConfig({
        profiles: [GLOBAL_PROFILE, REPORTING_PROFILE],
        rawContents: { [GLOBAL_PROFILE_ID]: { Configuration: scalarDoc } },
        contents: { [REPORTING_PROFILE_ID]: validReportingConfig() },
      });

      await expect(
        handler(createEvent(requestType), mockContext(testEnv)),
      ).rejects.toThrow(/expected a YAML object/);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it("fails with a sanitized message when a profile contains malformed YAML", async () => {
      // js-yaml embeds a source snippet in its error; the handler must not
      // surface it (threat I-3.1).
      const malformed = new TextEncoder().encode(
        "leases:\n  maxBudget: 50\n    sneaky: SENSITIVE_LEAK_VALUE\n",
      );
      mockAppConfig({
        profiles: [GLOBAL_PROFILE, REPORTING_PROFILE],
        rawContents: { [GLOBAL_PROFILE_ID]: { Configuration: malformed } },
        contents: { [REPORTING_PROFILE_ID]: validReportingConfig() },
      });

      const promise = handler(createEvent(requestType), mockContext(testEnv));
      await expect(promise).rejects.toThrow();
      const error = await promise.catch((e: Error) => e);
      expect(error.message).not.toContain("SENSITIVE_LEAK_VALUE");
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it("applies code defaults for fields absent from legacy AppConfig", async () => {
      const globalConfig = validGlobalConfig();
      // Legacy notification.emailFrom was optional and could be absent.
      delete (globalConfig.notification as Record<string, unknown>).emailFrom;
      // Legacy reporting could omit costReportGroups entirely.
      const reportingConfig = { requireCostReportGroup: false };

      mockAppConfig({
        profiles: [GLOBAL_PROFILE, REPORTING_PROFILE],
        contents: {
          [GLOBAL_PROFILE_ID]: globalConfig,
          [REPORTING_PROFILE_ID]: reportingConfig,
        },
      });

      await handler(createEvent(requestType), mockContext(testEnv));

      const items = (
        ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input
          .TransactItems ?? []
      ).map((t: any) => t.Put.Item);
      const bySection: Record<string, any> = Object.fromEntries(
        items.map((i: any) => [i.section, i]),
      );

      expect(bySection.notification.emailFrom).toBe("");
      expect(bySection.costReporting.costReportGroups).toEqual([]);
    });
  });

  describe("Delete Operations", () => {
    it("is a no-op that touches no AWS resources", async () => {
      const response = await handler(
        createEvent("Delete"),
        mockContext(testEnv),
      );

      expect(response.Data?.status).toBe("retained");
      expect(appConfigMock.calls()).toHaveLength(0);
      expect(appConfigDataMock.calls()).toHaveLength(0);
      expect(ddbMock.calls()).toHaveLength(0);
    });
  });
});
