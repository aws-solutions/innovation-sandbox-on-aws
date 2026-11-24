// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ConfigSchemaVersion } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import {
  AgentConfigSchema,
  AgentConfigWriteSchema,
  CleanupConfigSchema,
  CleanupConfigWriteSchema,
  CONFIG_BOUNDS,
  ConfigPutBodySchemas,
  ConfigSchemas,
  ConfigWriteSchemas,
  CostReportingConfigSchema,
  CostReportingConfigWriteSchema,
  DEFAULT_TERMS_OF_SERVICE,
  isSesNotificationEnabled,
  LeasesConfigSchema,
  LeasesConfigWriteSchema,
  MaintenanceConfigSchema,
  NotificationConfigSchema,
  NotificationConfigWriteSchema,
  TermsOfServiceConfigSchema,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import { describe, expect, it } from "vitest";

// A bump makes every stored config item unreadable by the previous release,
// so any change here must be a deliberate, reviewed decision.
it("ConfigSchemaVersion is unchanged", () => {
  expect(ConfigSchemaVersion).toEqual(1);
});

describe("LeasesConfigSchema", () => {
  it("fills code defaults from an empty object", () => {
    const parsed = LeasesConfigSchema.parse({});
    expect(parsed).toEqual({
      requireMaxBudget: true,
      maxBudget: 50,
      requireMaxDuration: true,
      maxDurationHours: 168,
      maxLeasesPerUser: 3,
      ttl: 30,
      allowUserLeaseTermination: true,
      leaseRequestWindowHours: 168,
      maxLeaseRequestsPerWindow: 10,
      leaseSharingEnabled: false,
      enablePrincipalSearch: true,
      groupAssignmentMode: "NONE",
      allowPredictiveBudgetControls: false,
      serviceBreakdownEnabled: false,
      allowBedrockTokenMonitoring: false,
    });
  });

  it("accepts valid overrides", () => {
    const parsed = LeasesConfigSchema.parse({
      maxBudget: 500,
      ttl: 90,
      enablePrincipalSearch: false,
      groupAssignmentMode: "NONE",
    });
    expect(parsed.maxBudget).toBe(500);
    expect(parsed.ttl).toBe(90);
    expect(parsed.enablePrincipalSearch).toBe(false);
    expect(parsed.groupAssignmentMode).toBe("NONE");
  });

  it("allows maxBudget and maxDurationHours of 0 (gte(0) bound)", () => {
    const parsed = LeasesConfigSchema.parse({
      maxBudget: 0,
      maxDurationHours: 0,
    });
    expect(parsed.maxBudget).toBe(0);
    expect(parsed.maxDurationHours).toBe(0);
  });

  it.each([
    { field: "maxLeasesPerUser", value: 0 },
    { field: "ttl", value: 0 },
    { field: "maxLeaseRequestsPerWindow", value: 0 },
    { field: "maxBudget", value: -1 },
    { field: "maxBudget", value: 1_000_000_001 },
    { field: "maxDurationHours", value: 87_601 },
  ])("rejects $field = $value", ({ field, value }) => {
    const result = LeasesConfigSchema.safeParse({ [field]: value });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    const result = LeasesConfigSchema.safeParse({ unexpected: true });
    expect(result.success).toBe(false);
  });

  describe("cross-field rule: leaseRequestWindowHours <= ttl * 24", () => {
    // The read schema does NOT enforce this rule: it must tolerate stored or
    // migrated config that violates it so the leases handler's runtime cap
    // stays reachable. The rule is enforced on the write path
    // (LeasesConfigWriteSchema) below.
    it("accepts a window at the ttl boundary", () => {
      const result = LeasesConfigSchema.safeParse({
        ttl: 7,
        leaseRequestWindowHours: 168, // 7 * 24
      });
      expect(result.success).toBe(true);
    });

    it("tolerates a window exceeding ttl * 24", () => {
      const result = LeasesConfigSchema.safeParse({
        ttl: 1,
        leaseRequestWindowHours: 25, // > 1 * 24
      });
      expect(result.success).toBe(true);
    });
  });
});

describe("LeasesConfigWriteSchema", () => {
  // The read-schema defaults form a fully-specified, valid write body.
  const validBody = LeasesConfigSchema.parse({});

  it("accepts a fully-specified body", () => {
    expect(LeasesConfigWriteSchema.safeParse(validBody).success).toBe(true);
  });

  it("rejects a body missing required fields (no defaults applied)", () => {
    const { maxBudget, ...partial } = validBody;
    void maxBudget; // intentionally omitted from the write body
    expect(LeasesConfigWriteSchema.safeParse(partial).success).toBe(false);
  });

  it("enforces the cross-field rule (window must not exceed ttl * 24)", () => {
    const result = LeasesConfigWriteSchema.safeParse({
      ...validBody,
      ttl: 1,
      leaseRequestWindowHours: 25,
    });
    expect(result.success).toBe(false);
  });

  it("caps ttl at MAX_TTL_DAYS", () => {
    expect(
      LeasesConfigWriteSchema.safeParse({
        ...validBody,
        ttl: CONFIG_BOUNDS.MAX_TTL_DAYS,
      }).success,
    ).toBe(true);
    expect(
      LeasesConfigWriteSchema.safeParse({
        ...validBody,
        ttl: CONFIG_BOUNDS.MAX_TTL_DAYS + 1,
      }).success,
    ).toBe(false);
  });

  it("caps ttl on the PUT body schema too, so an over-cap save is a 400", () => {
    // ConfigPutBodySchemas is what the configurations handler parses; without the
    // bound here the over-cap value only fails inside putSection, which surfaces
    // as a 500 rather than a validation error.
    expect(
      ConfigPutBodySchemas.leases.safeParse({
        ...validBody,
        ttl: CONFIG_BOUNDS.MAX_TTL_DAYS + 1,
      }).success,
    ).toBe(false);
  });

  it("still accepts a stored ttl above the cap on the read schema", () => {
    // GlobalConfigSchema validates on read, so bounding the read path would make
    // an existing deployment fail isbConfigMiddleware in every Lambda.
    expect(
      LeasesConfigSchema.safeParse({
        ...validBody,
        ttl: CONFIG_BOUNDS.MAX_TTL_DAYS + 1,
      }).success,
    ).toBe(true);
  });
});

describe("CleanupConfigSchema", () => {
  it("fills code defaults from an empty object", () => {
    expect(CleanupConfigSchema.parse({})).toEqual({
      numberOfFailedAttemptsToCancelCleanup: 3,
      waitBeforeRetryFailedAttemptSeconds: 5,
      numberOfSuccessfulAttemptsToFinishCleanup: 2,
      waitBeforeRerunSuccessfulAttemptSeconds: 30,
      validation: { failureAction: "Silent" },
      cooldownPeriodHours: 24,
      reportRetentionDays: 730,
    });
  });

  it("allows cooldownPeriodHours of 0 (no cooldown)", () => {
    expect(
      CleanupConfigSchema.parse({ cooldownPeriodHours: 0 }).cooldownPeriodHours,
    ).toBe(0);
  });

  it.each([
    { field: "numberOfFailedAttemptsToCancelCleanup", value: 0 },
    { field: "waitBeforeRetryFailedAttemptSeconds", value: 0 },
    { field: "cooldownPeriodHours", value: -1 },
    { field: "cooldownPeriodHours", value: 8641 },
    { field: "reportRetentionDays", value: 13 },
    { field: "reportRetentionDays", value: 3651 },
  ])("rejects $field = $value", ({ field, value }) => {
    expect(CleanupConfigSchema.safeParse({ [field]: value }).success).toBe(
      false,
    );
  });

  it("rejects an invalid validation.failureAction", () => {
    expect(
      CleanupConfigSchema.safeParse({
        validation: { failureAction: "Nope", delayAfterCleanupSeconds: 300 },
      }).success,
    ).toBe(false);
  });

  it("write schema requires all fields", () => {
    expect(CleanupConfigWriteSchema.safeParse({}).success).toBe(false);
  });
});

describe("NotificationConfigSchema", () => {
  it("fills code defaults from an empty object (no sender, SES on, SNS off)", () => {
    expect(NotificationConfigSchema.parse({})).toEqual({
      emailFrom: "",
      sesEnabled: true,
      snsIntegrationTopicEnabled: false,
    });
  });

  it("defaults the channel toggles on a stored item that predates them", () => {
    // A v1.3 `notification` item carries only emailFrom; reading it must keep
    // the pre-feature behavior (SES on, SNS off) rather than fail strict parse.
    expect(NotificationConfigSchema.parse({ emailFrom: "a@b.com" })).toEqual({
      emailFrom: "a@b.com",
      sesEnabled: true,
      snsIntegrationTopicEnabled: false,
    });
  });

  it("accepts a valid email and empty string", () => {
    expect(
      NotificationConfigSchema.safeParse({ emailFrom: "a@b.com" }).success,
    ).toBe(true);
    expect(NotificationConfigSchema.safeParse({ emailFrom: "" }).success).toBe(
      true,
    );
  });

  it("rejects an invalid email", () => {
    expect(
      NotificationConfigSchema.safeParse({ emailFrom: "not-an-email" }).success,
    ).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    expect(
      NotificationConfigSchema.safeParse({ emailFrom: "", unexpected: true })
        .success,
    ).toBe(false);
  });
});

describe("isSesNotificationEnabled", () => {
  it.each([
    { sesEnabled: true, emailFrom: "sender@example.com", expected: true },
    { sesEnabled: false, emailFrom: "sender@example.com", expected: false },
    { sesEnabled: true, emailFrom: "", expected: false },
    { sesEnabled: true, emailFrom: "   ", expected: false },
  ])(
    "returns $expected for sesEnabled=$sesEnabled and emailFrom='$emailFrom'",
    ({ expected, ...config }) => {
      expect(isSesNotificationEnabled(config)).toBe(expected);
    },
  );
});

describe("NotificationConfigWriteSchema", () => {
  it("rejects an empty body (all fields required, no defaults applied)", () => {
    expect(NotificationConfigWriteSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a body missing a channel toggle (no defaults applied)", () => {
    expect(
      NotificationConfigWriteSchema.safeParse({
        emailFrom: "a@b.com",
        sesEnabled: true,
      }).success,
    ).toBe(false);
  });

  it("accepts a fully-specified body", () => {
    expect(
      NotificationConfigWriteSchema.safeParse({
        emailFrom: "a@b.com",
        sesEnabled: true,
        snsIntegrationTopicEnabled: false,
      }).success,
    ).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    expect(
      NotificationConfigWriteSchema.safeParse({
        emailFrom: "a@b.com",
        sesEnabled: true,
        snsIntegrationTopicEnabled: false,
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});

describe("MaintenanceConfigSchema", () => {
  it("defaults enabled to true (fresh installs start in maintenance mode)", () => {
    expect(MaintenanceConfigSchema.parse({})).toEqual({ enabled: true });
  });
});

describe("TermsOfServiceConfigSchema", () => {
  it("defaults content to the generic ToS blurb", () => {
    expect(TermsOfServiceConfigSchema.parse({})).toEqual({
      content: DEFAULT_TERMS_OF_SERVICE,
    });
  });

  it("rejects content longer than 10000 characters", () => {
    const result = TermsOfServiceConfigSchema.safeParse({
      content: "x".repeat(10_001),
    });
    expect(result.success).toBe(false);
  });
});

describe("CostReportingConfigSchema", () => {
  it("fills code defaults from an empty object", () => {
    expect(CostReportingConfigSchema.parse({})).toEqual({
      costReportGroups: [],
      requireCostReportGroup: false,
    });
  });

  it("keeps an existing configuration with no required groups readable for repair", () => {
    const invalidConfig = {
      requireCostReportGroup: true,
      costReportGroups: [],
    };
    expect(CostReportingConfigSchema.parse(invalidConfig)).toEqual(
      invalidConfig,
    );
  });

  it("accepts the maximum number of groups", () => {
    const result = CostReportingConfigSchema.safeParse({
      costReportGroups: Array.from(
        { length: CONFIG_BOUNDS.MAX_COST_REPORT_GROUPS },
        (_, i) => `g${i}`,
      ),
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than the maximum number of groups", () => {
    const result = CostReportingConfigSchema.safeParse({
      costReportGroups: Array.from(
        { length: CONFIG_BOUNDS.MAX_COST_REPORT_GROUPS + 1 },
        (_, i) => `g${i}`,
      ),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a group name longer than the maximum length", () => {
    const result = CostReportingConfigSchema.safeParse({
      costReportGroups: [
        "x".repeat(CONFIG_BOUNDS.MAX_COST_REPORT_GROUP_LENGTH + 1),
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("CostReportingConfigWriteSchema", () => {
  const invalidConfig = {
    requireCostReportGroup: true,
    costReportGroups: [],
  };

  it.each([
    ["persistence", CostReportingConfigWriteSchema, invalidConfig],
    [
      "PUT request",
      ConfigPutBodySchemas.costReporting,
      { ...invalidConfig, meta: { lastEditTime: "2026-11-18T12:00:00Z" } },
    ],
  ])(
    "rejects missing required groups at the %s boundary",
    (_name, schema, data) => {
      const result = schema.safeParse(data);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual([
          expect.objectContaining({
            path: ["costReportGroups"],
            message:
              "Add at least one cost report group or turn off Require cost report group.",
          }),
        ]);
      }
    },
  );

  it.each([
    { requireCostReportGroup: false, costReportGroups: [] },
    { requireCostReportGroup: false, costReportGroups: ["Engineering"] },
    { requireCostReportGroup: true, costReportGroups: ["Engineering"] },
  ])("accepts a usable cost reporting configuration: %j", (config) => {
    expect(CostReportingConfigWriteSchema.parse(config)).toEqual(config);
    expect(ConfigPutBodySchemas.costReporting.parse(config)).toEqual(config);
  });
});

describe("AgentConfigSchema", () => {
  it("defaults sandboxSpacesEnabled to false", () => {
    expect(AgentConfigSchema.parse({})).toEqual({
      sandboxSpacesEnabled: false,
    });
  });

  it("accepts true and rejects a string value", () => {
    expect(
      AgentConfigSchema.parse({ sandboxSpacesEnabled: true })
        .sandboxSpacesEnabled,
    ).toBe(true);
    expect(
      AgentConfigSchema.safeParse({ sandboxSpacesEnabled: "ENABLED" }).success,
    ).toBe(false);
  });

  it("write schema requires a boolean sandboxSpacesEnabled (no default applied)", () => {
    expect(AgentConfigWriteSchema.safeParse({}).success).toBe(false);
    expect(
      AgentConfigWriteSchema.safeParse({ sandboxSpacesEnabled: "true" })
        .success,
    ).toBe(false);
    expect(
      AgentConfigWriteSchema.safeParse(AgentConfigSchema.parse({})).success,
    ).toBe(true);
  });
});

describe("ConfigSchemas / ConfigWriteSchemas registries", () => {
  const sections = [
    "leases",
    "cleanup",
    "notification",
    "maintenance",
    "termsOfService",
    "costReporting",
  ] as const;

  it("exposes a read and write schema for every section", () => {
    for (const section of sections) {
      expect(ConfigSchemas[section]).toBeDefined();
      expect(ConfigWriteSchemas[section]).toBeDefined();
    }
  });

  it("every read schema produces code defaults from an empty object", () => {
    for (const section of sections) {
      expect(ConfigSchemas[section].safeParse({}).success).toBe(true);
    }
  });
});
