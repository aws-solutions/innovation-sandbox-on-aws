// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CleanupConfigSchema,
  CleanupConfigWriteSchema,
  CONFIG_BOUNDS,
  ConfigSchemas,
  ConfigWriteSchemas,
  CostReportingConfigSchema,
  DEFAULT_TERMS_OF_SERVICE,
  LeasesConfigSchema,
  LeasesConfigWriteSchema,
  MaintenanceConfigSchema,
  NotificationConfigSchema,
  TermsOfServiceConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { describe, expect, it } from "vitest";

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
    });
  });

  it("accepts valid overrides", () => {
    const parsed = LeasesConfigSchema.parse({
      maxBudget: 500,
      ttl: 90,
      enablePrincipalSearch: false,
    });
    expect(parsed.maxBudget).toBe(500);
    expect(parsed.ttl).toBe(90);
    expect(parsed.enablePrincipalSearch).toBe(false);
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
  it("defaults emailFrom to empty string", () => {
    expect(NotificationConfigSchema.parse({})).toEqual({ emailFrom: "" });
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

  it("accepts exactly MAX_COST_REPORT_GROUPS groups", () => {
    const result = CostReportingConfigSchema.safeParse({
      costReportGroups: Array.from(
        { length: CONFIG_BOUNDS.MAX_COST_REPORT_GROUPS },
        (_, i) => `g${i}`,
      ),
    });
    expect(result.success).toBe(true);
  });

  it("rejects more than MAX_COST_REPORT_GROUPS groups", () => {
    const result = CostReportingConfigSchema.safeParse({
      costReportGroups: Array.from(
        { length: CONFIG_BOUNDS.MAX_COST_REPORT_GROUPS + 1 },
        (_, i) => `g${i}`,
      ),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a group name longer than MAX_COST_REPORT_GROUP_LENGTH characters", () => {
    const result = CostReportingConfigSchema.safeParse({
      costReportGroups: [
        "x".repeat(CONFIG_BOUNDS.MAX_COST_REPORT_GROUP_LENGTH + 1),
      ],
    });
    expect(result.success).toBe(false);
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
