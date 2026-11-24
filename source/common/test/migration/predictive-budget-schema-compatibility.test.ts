// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
  LeaseTemplateSchemaVersion,
  PersistedLeaseTemplateSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  LeaseSchemaVersion,
  PersistedLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";

// v1.4.0 added triggerOn, rateLimits, predictiveBudgetEnabled, and
// bedrockTokenMonitoringEnabled (schema version 4 -> 5). All new fields are
// optional or defaulted, so stored v4 records parse unchanged.

const storedV4LeaseTemplate = {
  uuid: "11111111-1111-4111-8111-111111111111",
  name: "myLeaseTemplate",
  requiresApproval: false,
  createdBy: "JohnDoe@amazon.com",
  visibility: "PUBLIC",
  allowOwnerToShareLease: false,
  maxSpend: 100,
  budgetThresholds: [{ dollarsSpent: 50, action: "ALERT" }],
  leaseDurationInHours: 48,
  durationThresholds: [{ hoursRemaining: 24, action: "ALERT" }],
  meta: {
    schemaVersion: 4,
    createdTime: "2025-10-01T00:00:00.000Z",
    lastEditTime: "2025-10-01T00:00:00.000Z",
  },
};

const storedV4Lease = {
  userEmail: "JohnDoe@amazon.com",
  uuid: "22222222-2222-4222-8222-222222222222",
  status: "Active",
  originalLeaseTemplateUuid: storedV4LeaseTemplate.uuid,
  originalLeaseTemplateName: storedV4LeaseTemplate.name,
  allowOwnerToShareLease: false,
  maxSpend: 100,
  budgetThresholds: [{ dollarsSpent: 50, action: "ALERT" }],
  leaseDurationInHours: 48,
  durationThresholds: [{ hoursRemaining: 24, action: "ALERT" }],
  awsAccountId: "123456789012",
  approvedBy: "AUTO_APPROVED",
  startDate: "2025-10-02T00:00:00.000Z",
  expirationDate: "2025-10-04T00:00:00.000Z",
  lastCheckedDate: "2025-10-03T00:00:00.000Z",
  totalCostAccrued: 42.5,
  meta: {
    schemaVersion: 4,
    createdTime: "2025-10-02T00:00:00.000Z",
    lastEditTime: "2025-10-03T00:00:00.000Z",
  },
};

test("stored v4 lease template still parses under v5 schema", () => {
  const parsed = PersistedLeaseTemplateSchema.parse(storedV4LeaseTemplate);
  expect(parsed.predictiveBudgetEnabled).toBe(false);
  expect(parsed.bedrockTokenMonitoringEnabled).toBe(false);
  expect(parsed.rateLimits).toBeUndefined();
});

test("stored v4 lease still parses under v5 schema", () => {
  const parsed = PersistedLeaseSchema.parse(storedV4Lease);
  expect(parsed.status).toBe("Active");
  if (parsed.status !== "Active") {
    throw new Error("unreachable");
  }
  expect(parsed.lastPredictedSpend).toBeUndefined();
  expect(parsed.rateLimits).toBeUndefined();
});

test.each([
  ["lease template", PersistedLeaseTemplateSchema, storedV4LeaseTemplate],
  ["lease", PersistedLeaseSchema, storedV4Lease],
] as const)("a v6-stamped %s is rejected", (_label, schema, record) => {
  expect(() =>
    schema.parse({ ...record, meta: { ...record.meta, schemaVersion: 6 } }),
  ).toThrow();
});

const rateLimits = [
  { basis: "HOURLY", rate: 10, action: "ALERT" },
  { basis: "HOURLY", rate: 15, action: "FREEZE_ACCOUNT" },
  { basis: "DAILY", rate: 300, action: "FREEZE_ACCOUNT" },
];

const storedV5LeaseTemplate = {
  ...storedV4LeaseTemplate,
  predictiveBudgetEnabled: true,
  bedrockTokenMonitoringEnabled: false,
  rateLimits,
  meta: { ...storedV4LeaseTemplate.meta, schemaVersion: 5 },
};

const storedV5Lease = {
  ...storedV4Lease,
  predictiveBudgetEnabled: true,
  rateLimits,
  lastEvaluatedHourlySpendRate: 4,
  meta: { ...storedV4Lease.meta, schemaVersion: 5 },
};

test("a v5 record carrying rateLimits parses", () => {
  expect(
    PersistedLeaseTemplateSchema.parse(storedV5LeaseTemplate).rateLimits,
  ).toEqual(rateLimits);
  const lease = PersistedLeaseSchema.parse(storedV5Lease);
  if (lease.status !== "Active") {
    throw new Error("unreachable");
  }
  expect(lease.rateLimits).toEqual(rateLimits);
});

test("v1.4.0 writes are stamped with schema version 5", () => {
  expect(LeaseTemplateSchemaVersion).toBe(5);
  expect(LeaseSchemaVersion).toBe(5);
});

// The singular hourly/daily pair existed only in pre-release builds. It is not
// part of the contract, so it is an unknown member like any other.
describe("a singular rateLimit member", () => {
  const singular = { maxHourlyRate: 12, maxDailyRate: 200 };

  test("is rejected on a lease template, beside or without rateLimits", () => {
    const { rateLimits: _list, ...withoutList } = storedV5LeaseTemplate;
    for (const template of [storedV5LeaseTemplate, withoutList]) {
      expect(() =>
        PersistedLeaseTemplateSchema.parse({
          ...template,
          rateLimit: singular,
        }),
      ).toThrow();
    }
  });

  // The lease record schema is not strict; the strict write paths reject the
  // pair (see the leases handler).
  test("is not carried by a stored lease, whose schema strips unknown keys", () => {
    const parsed = PersistedLeaseSchema.parse({
      ...storedV5Lease,
      rateLimit: singular,
    });
    expect(parsed).not.toHaveProperty("rateLimit");
    expect(parsed).toMatchObject({ rateLimits });
  });
});

describe("rateLimits entries", () => {
  const withRateLimits = (rateLimits: unknown) => ({
    ...storedV5LeaseTemplate,
    rateLimits,
  });
  const entry = (rate: number, basis = "HOURLY", action = "ALERT") => ({
    basis,
    rate,
    action,
  });

  const ten = Array.from({ length: 10 }, (_, i) => entry(i + 1));

  test.each([
    ["ten entries", ten],
    ["an empty list", []],
    [
      "the same rate on different bases and several freezes",
      [
        entry(10, "HOURLY", "FREEZE_ACCOUNT"),
        entry(10, "DAILY", "FREEZE_ACCOUNT"),
        entry(20, "HOURLY", "FREEZE_ACCOUNT"),
      ],
    ],
  ])("accept %s", (_label, limits) => {
    expect(
      PersistedLeaseTemplateSchema.parse(withRateLimits(limits)).rateLimits,
    ).toEqual(limits);
  });

  test("reject a repeated (basis, rate) pair whatever the action", () => {
    expect(() =>
      PersistedLeaseTemplateSchema.parse(
        withRateLimits([entry(10), entry(10, "HOURLY", "FREEZE_ACCOUNT")]),
      ),
    ).toThrow(/duplicate rate limit/);
  });

  test.each([
    ["an eleventh entry", [...ten, entry(11)]],
    ["a zero rate", [entry(0)]],
    ["a negative rate", [entry(-1)]],
    ["an unknown basis", [entry(5, "WEEKLY")]],
    ["an unknown action", [entry(5, "HOURLY", "TERMINATE")]],
    ["an unknown member", [{ ...entry(5), triggerOn: "PREDICTED" }]],
    ["a missing member", [{ basis: "HOURLY", rate: 5 }]],
  ])("reject %s", (_label, rateLimits) => {
    expect(() =>
      PersistedLeaseTemplateSchema.parse(withRateLimits(rateLimits)),
    ).toThrow();
  });
});

test("threshold with triggerOn PREDICTED parses; unknown keys still rejected", () => {
  const withTriggerOn = {
    ...storedV4LeaseTemplate,
    budgetThresholds: [
      { dollarsSpent: 50, action: "ALERT", triggerOn: "PREDICTED" },
    ],
    meta: { ...storedV4LeaseTemplate.meta, schemaVersion: 5 },
  };
  expect(
    PersistedLeaseTemplateSchema.parse(withTriggerOn).budgetThresholds?.[0]
      ?.triggerOn,
  ).toBe("PREDICTED");

  const withUnknownKey = {
    ...storedV4LeaseTemplate,
    budgetThresholds: [{ dollarsSpent: 50, action: "ALERT", bogus: true }],
  };
  expect(() => PersistedLeaseTemplateSchema.parse(withUnknownKey)).toThrow();
});
