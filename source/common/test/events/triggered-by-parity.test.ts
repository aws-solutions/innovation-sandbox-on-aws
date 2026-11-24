// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { describe, expect, test, vi } from "vitest";

import {
  BreachRecord,
  BreachRecordSchema,
  LeaseCostHistorySchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import {
  LeaseFreezingEventSchema,
  LeaseFreezingThresholdBreachedAlert,
} from "@amzn/innovation-sandbox-commons/events/lease-freezing-threshold-breached-alert.js";
import {
  LeaseFrozenEvent,
  LeaseFrozenEventSchema,
} from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import { LeaseSpendRateThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-spend-rate-threshold-breached-alert.js";
import {
  budgetAlertThresholdClause,
  EmailTemplates,
} from "@amzn/innovation-sandbox-commons/isb-services/notification/email-templates.js";
import { SubscribableLogSchema } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { futureTtl } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { DollarThresholdTriggeredBySchema } from "@amzn/innovation-sandbox-shared/types/cost-history.js";

/**
 * Producer/consumer parity for the dollar-threshold `triggeredBy` enum.
 *
 * Exhaustiveness is compile-enforced by the keyed `Record` in email-templates.ts:
 * `budgetAlertThresholdClause` is typed on the enum, so an added value fails the
 * build there and in the fixture below. The one runtime check worth keeping is
 * comparing that hand-written Record's keys against the owning enum, since it is
 * the only consumer allowlist not derived from it.
 *
 * The dollar contracts carry REPORTED and PREDICTED only. A crossed spend-rate
 * limit (a `RATE` BREACH# row) alerts through LeaseSpendRateThresholdBreachedAlert
 * and freezes with a SpendRateExceeded reason; both are covered below.
 *
 * What is left to check at runtime is that each branch's copy is complete and
 * accurate for the fields that value's producers carry -- the failure mode is a
 * rendered `undefined`, not a missing branch.
 */
const baseDetail = {
  leaseId: {
    userEmail: "someone@example.com",
    uuid: "750e8400-e29b-41d4-a716-446655440002",
  },
  accountId: "123456789012",
  totalSpend: 60,
  actionRequested: "ALERT",
} as const;

const detailPerTriggeredBy: Record<
  LeaseBudgetThresholdBreachedAlert["Detail"]["triggeredBy"],
  LeaseBudgetThresholdBreachedAlert["Detail"]
> = {
  REPORTED: {
    ...baseDetail,
    triggeredBy: "REPORTED",
    budget: 100,
    budgetThresholdTriggered: 70,
  },
  PREDICTED: {
    ...baseDetail,
    triggeredBy: "PREDICTED",
    budget: 100,
    budgetThresholdTriggered: 70,
    predictedCost: 72,
    rate: 3.5,
    rateSource: "HOURLY",
    hoursToBudgetExhaustion: 8,
  },
};

const spendRateDetail: LeaseSpendRateThresholdBreachedAlert["Detail"] = {
  leaseId: baseDetail.leaseId,
  accountId: baseDetail.accountId,
  totalSpend: 60,
  rateBasis: "HOURLY",
  thresholdRate: 12,
  measuredRate: 14,
};

const emailContext = {
  webAppUrl: "https://example.com",
  destination: { to: ["someone@example.com"] },
};

function spendRateAlertBodies(
  detail: LeaseSpendRateThresholdBreachedAlert["Detail"],
): string[] {
  const { textBody, htmlBody } = EmailTemplates.LeaseSpendRateThresholdAlert(
    new LeaseSpendRateThresholdBreachedAlert(detail),
    emailContext,
  );
  return [textBody, htmlBody].map((body) => body.replace(/\s+/g, " "));
}

describe("v1.3-shaped construction stays additive", () => {
  test("constructing without triggeredBy compiles and yields REPORTED", () => {
    // A v1.3 call site omits every field this feature added. It must still
    // compile (the constructor takes the schema's input type) and the default
    // must be applied.
    const alert = new LeaseBudgetThresholdBreachedAlert({
      leaseId: {
        userEmail: "someone@example.com",
        uuid: "750e8400-e29b-41d4-a716-446655440002",
      },
      accountId: "123456789012",
      budget: 100,
      totalSpend: 60,
      budgetThresholdTriggered: 70,
      actionRequested: "ALERT",
    });

    expect(alert.Detail.triggeredBy).toBe("REPORTED");
  });

  test("the dollar alert carries no spend-rate fields", () => {
    // A spend-rate limit has its own contract, so a rate pair spread onto a
    // dollar alert is stripped rather than travelling on the bus.
    const alert = LeaseBudgetThresholdBreachedAlert.parse({
      ...detailPerTriggeredBy.REPORTED,
      thresholdRate: 12,
      thresholdRateBasis: "HOURLY",
    });

    expect(alert.Detail).not.toHaveProperty("thresholdRate");
    expect(alert.Detail).not.toHaveProperty("thresholdRateBasis");
  });
});

// Asserted on `parse`, the consumer path: the producer must not throw.
describe("each branch must carry the threshold its copy names", () => {
  const base = {
    leaseId: {
      userEmail: "someone@example.com",
      uuid: "750e8400-e29b-41d4-a716-446655440002",
    },
    accountId: "123456789012",
    totalSpend: 60,
    actionRequested: "ALERT" as const,
  };

  test.each(["REPORTED", "PREDICTED"] as const)(
    "%s without budgetThresholdTriggered is rejected, not rendered",
    (triggeredBy) => {
      expect(() =>
        LeaseBudgetThresholdBreachedAlert.parse({ ...base, triggeredBy }),
      ).toThrow();
    },
  );

  test.each(["REPORTED", "PREDICTED"] as const)(
    "%s with a null budgetThresholdTriggered is rejected, not rendered",
    (triggeredBy) => {
      expect(() =>
        LeaseBudgetThresholdBreachedAlert.parse({
          ...base,
          triggeredBy,
          budgetThresholdTriggered: null,
        }),
      ).toThrow();
    },
  );

  test("a v1.3 detail omitting triggeredBy still parses", () => {
    const alert = LeaseBudgetThresholdBreachedAlert.parse({
      ...base,
      budget: 100,
      budgetThresholdTriggered: 70,
    });
    expect(alert.Detail.triggeredBy).toBe("REPORTED");
  });

  test.each(["ALERT", "FREEZE_ACCOUNT"] as const)(
    "triggeredBy RATE is rejected on a %s dollar alert: a spend-rate limit has its own contract",
    (actionRequested) => {
      expect(() =>
        LeaseBudgetThresholdBreachedAlert.parse({
          ...base,
          actionRequested,
          budgetThresholdTriggered: 70,
          triggeredBy: "RATE",
          thresholdRate: 12,
          thresholdRateBasis: "HOURLY",
        }),
      ).toThrow();
    },
  );

  // The predicted copy names the projection, the rate driving it and that
  // rate's period, so an alert missing any of the three renders a claim it cannot
  // support. BreachRecordSchema requires the same pair on a PREDICTED row.
  test.each(["predictedCost", "rate", "rateSource"] as const)(
    "PREDICTED without %s is rejected",
    (omitted) => {
      const detail: Record<string, unknown> = {
        ...base,
        triggeredBy: "PREDICTED",
        budgetThresholdTriggered: 70,
        predictedCost: 72,
        rate: 3.5,
        rateSource: "HOURLY",
      };
      delete detail[omitted];

      expect(() => LeaseBudgetThresholdBreachedAlert.parse(detail)).toThrow();
    },
  );

  test.each(["predictedCost", "rate", "rateSource"] as const)(
    "PREDICTED with a null %s is rejected",
    (nulled) => {
      expect(() =>
        LeaseBudgetThresholdBreachedAlert.parse({
          ...base,
          triggeredBy: "PREDICTED",
          budgetThresholdTriggered: 70,
          predictedCost: 72,
          rate: 3.5,
          rateSource: "HOURLY",
          [nulled]: null,
        }),
      ).toThrow();
    },
  );

  test("a PREDICTED alert with no projection is a compile error", () => {
    // @ts-expect-error PREDICTED requires predictedCost, rate and rateSource
    new LeaseBudgetThresholdBreachedAlert({
      ...base,
      triggeredBy: "PREDICTED",
      budgetThresholdTriggered: 70,
    });
  });

  test("a branch missing its threshold is a compile error, not a runtime emit", () => {
    // The consumer's parse would reject this detail, EventBridge would retry and
    // drop it, and the notification would be lost while the freeze still
    // happened -- so the producer must not be able to build it. Deleting
    // `budgetThresholdTriggered` below must fail `tsc`, and RATE is not a
    // dollar trigger at all.
    // @ts-expect-error REPORTED requires budgetThresholdTriggered
    new LeaseBudgetThresholdBreachedAlert({ ...base, triggeredBy: "REPORTED" });
    new LeaseBudgetThresholdBreachedAlert({
      ...base,
      budgetThresholdTriggered: 70,
      // @ts-expect-error RATE is not a dollar-threshold trigger
      triggeredBy: "RATE",
    });
  });
});

// The alert is emitted from the `BREACH#` row just persisted, so every
// null BreachRecordSchema mandates has to survive the projection.
describe("a persisted BreachRecord projects into a valid alert detail", () => {
  const breachBase = {
    leaseUuid: "750e8400-e29b-41d4-a716-446655440002",
    sk: "BREACH#2026-08-11T11:00:00.000Z",
    billedCostAtFire: 60.0,
    evaluatedBy: "LEASE_MONITORING" as const,
    evaluatedSpendAtFire: null,
    monitoredBedrockTokenCostAtFire: null,
    ttl: futureTtl(),
    meta: { schemaVersion: LeaseCostHistorySchemaVersion },
  };

  const project = (row: BreachRecord) => ({
    leaseId: { userEmail: "someone@example.com", uuid: row.leaseUuid },
    accountId: "123456789012",
    totalSpend: row.billedCostAtFire,
    budgetThresholdTriggered: row.thresholdDollars,
    actionRequested: row.action,
    triggeredBy: row.triggeredBy,
    predictedCost: row.predictedCostAtFire,
    rate: row.rateAtFire,
    rateSource: row.rateSourceAtFire,
    insight: row.insight,
  });

  // Both rate-at-fire fields are populated on a PREDICTED and a RATE
  // breach, so the projection cases below carry them. `insight` is null on any
  // branch where none was available, which is what these two exercise.
  test("a PREDICTED row with no insight", () => {
    const row = BreachRecordSchema.parse({
      ...breachBase,
      triggeredBy: "PREDICTED",
      action: "FREEZE_ACCOUNT",
      thresholdDollars: 70.0,
      thresholdRate: null,
      thresholdRateBasis: null,
      predictedCostAtFire: 72.0,
      rateAtFire: 2.0,
      rateSourceAtFire: "HOURLY",
      insight: null,
    });

    const alert = LeaseBudgetThresholdBreachedAlert.parse(project(row));
    expect(alert.Detail.triggeredBy).toBe("PREDICTED");
    expect(alert.Detail.rate).toBe(2.0);
    expect(alert.Detail.insight).toBeNull();
  });

  test("a REPORTED row with no rate and no insight", () => {
    // The one branch that allows a null rate-at-fire pair: a REPORTED
    // threshold fires whether or not a rate was ever in force.
    const row = BreachRecordSchema.parse({
      ...breachBase,
      triggeredBy: "REPORTED",
      action: "ALERT",
      thresholdDollars: 70.0,
      thresholdRate: null,
      thresholdRateBasis: null,
      predictedCostAtFire: null,
      rateAtFire: null,
      rateSourceAtFire: null,
      insight: null,
    });

    const alert = LeaseBudgetThresholdBreachedAlert.parse(project(row));
    expect(alert.Detail.rate).toBeNull();
    expect(alert.Detail.rateSource).toBeNull();
    expect(alert.Detail.insight).toBeNull();
  });

  // A RATE row is a spend-rate crossing, so it projects into the spend-rate
  // contracts: its basis and limit name the configured entry, and its rate at
  // fire is the measured rate that crossed it.
  const rateRow = (action: "ALERT" | "FREEZE_ACCOUNT") =>
    BreachRecordSchema.parse({
      ...breachBase,
      triggeredBy: "RATE",
      action,
      thresholdDollars: null,
      thresholdRate: 12.0,
      thresholdRateBasis: "DAILY",
      predictedCostAtFire: null,
      rateAtFire: 14.0,
      rateSourceAtFire: "DAILY",
      insight: null,
    });

  test("a RATE row projects into a valid spend-rate alert detail", () => {
    const row = rateRow("ALERT");

    const alert = LeaseSpendRateThresholdBreachedAlert.parse({
      leaseId: { userEmail: "someone@example.com", uuid: row.leaseUuid },
      accountId: "123456789012",
      rateBasis: row.thresholdRateBasis,
      thresholdRate: row.thresholdRate,
      measuredRate: row.rateAtFire,
      totalSpend: row.billedCostAtFire,
      predictedCost: row.predictedCostAtFire,
      insight: row.insight,
    });

    expect(alert.DetailType).toBe(
      EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
    );
    expect(alert.Detail).toMatchObject({
      rateBasis: "DAILY",
      thresholdRate: 12.0,
      measuredRate: 14.0,
      totalSpend: 60.0,
      predictedCost: null,
      insight: null,
    });
    for (const body of spendRateAlertBodies(alert.Detail)) {
      expect(body).not.toContain("undefined");
    }
  });

  test("a RATE row cannot project into a dollar alert", () => {
    const row = rateRow("ALERT");
    expect(() =>
      LeaseBudgetThresholdBreachedAlert.parse(project(row)),
    ).toThrow();
  });

  test("a FREEZE_ACCOUNT RATE row projects into a valid SpendRateExceeded freeze", () => {
    const row = rateRow("FREEZE_ACCOUNT");

    const parsed = LeaseFreezingEventSchema.parse({
      leaseId: { userEmail: "someone@example.com", uuid: row.leaseUuid },
      accountId: "123456789012",
      reason: {
        type: "SpendRateExceeded",
        rateBasis: row.thresholdRateBasis,
        thresholdRate: row.thresholdRate,
        measuredRate: row.rateAtFire,
        totalSpend: row.billedCostAtFire,
      },
    });

    expect(parsed.reason).toEqual({
      type: "SpendRateExceeded",
      rateBasis: "DAILY",
      thresholdRate: 12.0,
      measuredRate: 14.0,
      totalSpend: 60.0,
    });
  });

  test("hoursToBudgetExhaustion is null wherever the rate it derives from is", () => {
    // The one added field with no BreachRecord counterpart. It is computed
    // from the rate, so it is unavailable exactly when the rate is, and a
    // producer emitting null for one must not emit undefined for the other.
    const alert = LeaseBudgetThresholdBreachedAlert.parse({
      leaseId: {
        userEmail: "someone@example.com",
        uuid: "750e8400-e29b-41d4-a716-446655440002",
      },
      accountId: "123456789012",
      totalSpend: 60,
      budgetThresholdTriggered: 70,
      actionRequested: "ALERT",
      triggeredBy: "REPORTED",
      rate: null,
      hoursToBudgetExhaustion: null,
    });

    expect(alert.Detail.hoursToBudgetExhaustion).toBeNull();
  });
});

describe("a freeze names the threshold kind that requested it", () => {
  const frozenBase = {
    leaseId: {
      userEmail: "someone@example.com",
      uuid: "750e8400-e29b-41d4-a716-446655440002",
    },
    accountId: "123456789012",
  };
  const spendRateReason = {
    type: "SpendRateExceeded",
    rateBasis: "HOURLY",
    thresholdRate: 15,
    measuredRate: 16,
    totalSpend: 72,
    budget: 200,
  } as const;
  const { budget: _budget, ...unbudgetedReason } = spendRateReason;
  const freezeSchemas = [
    ["LeaseFrozenEventSchema", LeaseFrozenEventSchema],
    ["LeaseFreezingEventSchema", LeaseFreezingEventSchema],
  ] as const;

  function expectRejectedAt(
    schema: (typeof freezeSchemas)[number][1],
    reason: object,
    field: string,
    message?: string,
  ) {
    const result = schema.safeParse({ ...frozenBase, reason });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["reason", field],
        ...(message === undefined ? {} : { message }),
      }),
    );
  }

  test.each(freezeSchemas)(
    "%s accepts a SpendRateExceeded freeze naming its limit and measured rate, with or without a budget",
    (_name, schema) => {
      for (const reason of [spendRateReason, unbudgetedReason]) {
        expect(schema.parse({ ...frozenBase, reason }).reason).toEqual(reason);
      }
    },
  );

  test.each(
    freezeSchemas.flatMap(([name, schema]) =>
      (["rateBasis", "thresholdRate", "measuredRate"] as const).map(
        (field) => [name, schema, field] as const,
      ),
    ),
  )(
    "%s rejects a SpendRateExceeded freeze missing %s",
    (_name, schema, field) => {
      expectRejectedAt(
        schema,
        { ...spendRateReason, [field]: undefined },
        field,
      );
    },
  );

  const budgetExceeded = { type: "BudgetExceeded", totalSpend: 72 } as const;

  test.each([
    [
      "a zero spend rate limit",
      { ...spendRateReason, thresholdRate: 0 },
      "thresholdRate",
    ],
    [
      "a negative spend rate limit",
      { ...spendRateReason, thresholdRate: -1 },
      "thresholdRate",
    ],
    [
      "a negative measured rate",
      { ...spendRateReason, measuredRate: -0.01 },
      "measuredRate",
    ],
    [
      "an unknown spend rate basis",
      { ...spendRateReason, rateBasis: "WEEKLY" },
      "rateBasis",
    ],
    [
      "REPORTED without a dollar threshold",
      { ...budgetExceeded, triggeredBy: "REPORTED" },
      "triggeredBudgetThreshold",
    ],
    [
      "legacy reason without a dollar threshold",
      budgetExceeded,
      "triggeredBudgetThreshold",
    ],
    [
      "PREDICTED without a dollar threshold",
      { ...budgetExceeded, triggeredBy: "PREDICTED", rateSource: "HOURLY" },
      "triggeredBudgetThreshold",
    ],
    [
      "a zero dollar threshold",
      { ...budgetExceeded, triggeredBudgetThreshold: 0 },
      "triggeredBudgetThreshold",
    ],
    [
      "REPORTED with rateSource",
      {
        ...budgetExceeded,
        triggeredBy: "REPORTED",
        triggeredBudgetThreshold: 70,
        rateSource: "HOURLY",
      },
      "rateSource",
      "only a PREDICTED freeze carries a rateSource",
    ],
    [
      "PREDICTED without rateSource",
      {
        ...budgetExceeded,
        triggeredBy: "PREDICTED",
        triggeredBudgetThreshold: 70,
      },
      "rateSource",
      "required when triggeredBy is PREDICTED",
    ],
  ] as const)(
    "reports %s at the exact path",
    (_label, reason, field, message?: string) => {
      expectRejectedAt(LeaseFrozenEventSchema, reason, field, message);
    },
  );

  test.each([
    [
      "SpendRateExceeded",
      "dollar-threshold",
      spendRateReason,
      {
        triggeredBudgetThreshold: 70,
        triggeredBy: "PREDICTED",
        rateSource: "HOURLY",
      },
    ],
    [
      "BudgetExceeded",
      "spend-rate",
      {
        ...budgetExceeded,
        triggeredBy: "REPORTED",
        triggeredBudgetThreshold: 70,
      },
      { thresholdRate: 15, thresholdRateBasis: "HOURLY", rate: 16 },
    ],
  ] as const)(
    "a %s freeze strips stray %s fields rather than carrying them",
    (_type, _kind, reason, strays) => {
      const parsed = LeaseFrozenEventSchema.parse({
        ...frozenBase,
        reason: { ...reason, ...strays },
      });
      expect(parsed.reason).toEqual(reason);
    },
  );

  test.each(freezeSchemas)(
    "%s rejects a BudgetExceeded reason whose trigger is not a dollar threshold",
    (_name, schema) => {
      for (const reason of [
        {
          ...budgetExceeded,
          triggeredBudgetThreshold: 70,
          triggeredBy: "RATE",
        },
        {
          ...budgetExceeded,
          budget: 200,
          triggeredBy: "RATE",
          thresholdRate: 15,
          thresholdRateBasis: "HOURLY",
          rate: 16,
        },
        {
          ...budgetExceeded,
          triggeredBudgetThreshold: 70,
          triggeredBy: "MAX_SPEND",
        },
      ]) {
        expect(() => schema.parse({ ...frozenBase, reason })).toThrow();
      }
    },
  );

  const freezeEmails = (event: LeaseFrozenEvent) => [
    EmailTemplates.LeaseFrozen.byBudgetUser(
      event as LeaseFrozenEvent<"SpendRateExceeded">,
      emailContext,
    ),
    EmailTemplates.LeaseFrozen.byBudgetAdminManager(
      event as LeaseFrozenEvent<"SpendRateExceeded">,
      {
        webAppUrl: "https://example.com",
        destination: { bcc: ["manager@example.com"] },
      },
    ),
  ];

  test.each([
    {
      basis: "HOURLY, budgeted",
      reason: spendRateReason,
      present: [
        "spend rate of USD 16.00/hour exceeded the spend rate limit of USD 15.00/hour",
        "the last confirmed cost was USD 72.00 against the assigned budget of USD 200.00",
      ],
      absent: ["/day"],
    },
    {
      basis: "DAILY, unbudgeted",
      reason: {
        ...unbudgetedReason,
        rateBasis: "DAILY",
        thresholdRate: 12.5,
        measuredRate: 13.456,
        totalSpend: 70.35000000000001,
      },
      present: [
        "spend rate of USD 13.46/day exceeded the spend rate limit of USD 12.50/day",
        "the last confirmed cost was USD 70.35.",
      ],
      absent: ["/hour", "assigned budget"],
    },
  ])(
    "a $basis SpendRateExceeded freeze renders its limit and measured rate through format-utils",
    ({ reason, present, absent }) => {
      const event = LeaseFrozenEvent.parse({ ...frozenBase, reason });
      for (const email of freezeEmails(event)) {
        expect(email.subject).toContain(
          "Account Freeze Action based on Spend Rate Limit",
        );
        for (const body of [email.textBody, email.htmlBody]) {
          const normalized = body.replace(/\s+/g, " ");
          for (const phrase of [...present, "not a confirmed charge"]) {
            expect(normalized).toContain(phrase);
          }
          for (const phrase of [...absent, "freeze threshold", "undefined"]) {
            expect(normalized).not.toContain(phrase);
          }
        }
      }
    },
  );

  test("a BudgetExceeded freeze still reports its basis as the allowed budget", () => {
    const event = LeaseFrozenEvent.parse({
      ...frozenBase,
      reason: {
        type: "BudgetExceeded",
        triggeredBudgetThreshold: 70,
        budget: 100,
        totalSpend: 72,
        triggeredBy: "REPORTED",
      },
    });
    for (const email of freezeEmails(event)) {
      expect(email.subject).toContain(
        "Account Freeze Action based on Allowed Budget",
      );
      expect(email.subject).not.toContain("Spend Rate");
      expect(email.textBody).not.toContain("undefined");
    }
  });

  test.each([
    ["REPORTED", undefined],
    ["PREDICTED", "HOURLY"],
  ] as const)(
    "LeaseFrozenEventSchema accepts triggeredBy %s",
    (triggeredBy, rateSource) => {
      expect(() =>
        LeaseFrozenEventSchema.parse({
          ...frozenBase,
          reason: {
            type: "BudgetExceeded",
            triggeredBudgetThreshold: 70,
            totalSpend: 72,
            triggeredBy,
            rateSource,
          },
        }),
      ).not.toThrow();
    },
  );

  test("a v1.3 freeze carrying neither field still parses", () => {
    expect(() =>
      LeaseFrozenEventSchema.parse({
        ...frozenBase,
        reason: {
          type: "BudgetExceeded",
          triggeredBudgetThreshold: 70,
          totalSpend: 72,
        },
      }),
    ).not.toThrow();
  });

  test("a malformed SpendRateExceeded pre-freeze warning is emitted and recorded", () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    try {
      const { measuredRate: _measuredRate, ...reason } = spendRateReason;
      const warning = new LeaseFreezingThresholdBreachedAlert({
        ...frozenBase,
        reason,
      } as unknown as ConstructorParameters<
        typeof LeaseFreezingThresholdBreachedAlert
      >[0]);

      expect(warning.Detail.reason.type).toBe("SpendRateExceeded");
      expect(warn).toHaveBeenCalledWith(
        `${LogPatterns.DataValidationWarning.pattern}: emitting an invalid ${EventDetailTypes.LeaseFreezingThresholdBreachedAlert} detail`,
        expect.objectContaining({
          logDetailType: "InvalidEventDetailEmitted",
          eventDetailType: EventDetailTypes.LeaseFreezingThresholdBreachedAlert,
          invalidPaths: ["reason.measuredRate"],
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

// Asserted through the event path, not only the persisted schema: the rule
// currently holds because BudgetAlertInsightSchema aliases BreachInsightSchema,
// and restating it locally to drop the cross-layer import would otherwise be
// silent. A kind without its figure renders "(undefined%)" in the sent copy.
describe("an alert insight must carry the figure its kind names", () => {
  const base = {
    leaseId: {
      userEmail: "someone@example.com",
      uuid: "750e8400-e29b-41d4-a716-446655440002",
    },
    accountId: "123456789012",
    totalSpend: 60,
    actionRequested: "ALERT" as const,
    triggeredBy: "REPORTED" as const,
    budgetThresholdTriggered: 70,
  };

  test.each([
    ["COMPOSITION", "shareOfComparedSpend", "changePercent"],
    ["CHANGE", "changePercent", "shareOfComparedSpend"],
  ] as const)(
    "kind %s requires %s and is not satisfied by %s",
    (kind, required, other) => {
      const insight = { kind, service: "Amazon Bedrock", amount: 52.1 };

      expect(() =>
        LeaseBudgetThresholdBreachedAlert.parse({ ...base, insight }),
      ).toThrow();
      // The other kind's figure must not satisfy this one, or the two
      // refinements collapse into "some figure is present".
      expect(() =>
        LeaseBudgetThresholdBreachedAlert.parse({
          ...base,
          insight: { ...insight, [other]: 0.5 },
        }),
      ).toThrow();
      expect(() =>
        LeaseBudgetThresholdBreachedAlert.parse({
          ...base,
          insight: { ...insight, [required]: 0.5 },
        }),
      ).not.toThrow();
    },
  );

  test("NEW_ENTRANT needs neither figure", () => {
    expect(() =>
      LeaseBudgetThresholdBreachedAlert.parse({
        ...base,
        insight: {
          kind: "NEW_ENTRANT",
          service: "Amazon Bedrock",
          amount: 52.1,
        },
      }),
    ).not.toThrow();
  });
});

describe("triggeredBy producer/consumer parity", () => {
  test.each(DollarThresholdTriggeredBySchema.options)(
    "the notification clause for %s renders no undefined",
    (triggeredBy) => {
      const clause = budgetAlertThresholdClause[triggeredBy](
        detailPerTriggeredBy[triggeredBy],
      );

      expect(clause).not.toContain("undefined");
      expect(clause.length).toBeGreaterThan(0);
    },
  );

  // Asserted on the ASSEMBLED body, not the clause alone. The clause-only checks
  // in this file all passed while the sent copy read "...has is projected to
  // cross...", because the template supplied a "has" that only fits a
  // past-participle branch. Each clause now carries its own verb, and this is the
  // assertion that fails if a future branch stops doing so.
  test.each([
    ["REPORTED", "has reached the budget threshold of USD 70.00"],
    ["PREDICTED", "is projected to cross its configured budget threshold"],
  ] as const)(
    "the %s body reads as one grammatical sentence after the lease ID",
    (triggeredBy, expectedPhrase) => {
      const { textBody, htmlBody } = EmailTemplates.LeaseBudgetAlert(
        {
          DetailType: EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
          Detail: detailPerTriggeredBy[triggeredBy],
        } as LeaseBudgetThresholdBreachedAlert,
        {
          webAppUrl: "https://example.com",
          destination: { to: ["someone@example.com"] },
        },
      );

      for (const body of [textBody, htmlBody]) {
        const normalized = body.replace(/\s+/g, " ");
        expect(normalized).toContain(
          `750e8400-e29b-41d4-a716-446655440002 ${expectedPhrase}`,
        );
        // The specific breakages a template-supplied verb produces.
        expect(normalized).not.toMatch(/\bhas (is|has|was|were)\b/);
        expect(normalized).not.toContain("undefined");
      }
    },
  );

  test("a PREDICTED clause names the projection and never claims the threshold was reached", () => {
    // The parity assertion above only rejects "undefined", which a clause that
    // reused the REPORTED wording would pass trivially: that clause rendered
    // "reached the budget threshold of USD 70.00" against USD 60.00 of confirmed
    // spend, and on a FREEZE_ACCOUNT threshold it misstates why the account was
    // frozen.
    const clause = budgetAlertThresholdClause.PREDICTED(
      detailPerTriggeredBy.PREDICTED,
    );

    expect(clause).toContain("projected");
    expect(clause).not.toContain("reached");
  });

  test("the spend-rate alert body names the limit, not a dollar threshold, after the lease ID", () => {
    for (const body of spendRateAlertBodies(spendRateDetail)) {
      expect(body).toContain(
        "750e8400-e29b-41d4-a716-446655440002 has exceeded its configured spend rate limit of USD 12.00/hour; the measured rate is USD 14.00/hour",
      );
      expect(body).not.toContain("budget threshold");
      expect(body).not.toMatch(/\bhas (is|has|was|were)\b/);
      expect(body).not.toContain("undefined");
    }
  });

  test("the notification clause map covers every value of the owning enum", () => {
    // The one consumer allowlist written out rather than derived from
    // DollarThresholdTriggeredBySchema, so a producer value with no branch is a
    // real gap. RATE is not a dollar trigger, so it has no key here.
    expect(Object.keys(budgetAlertThresholdClause).sort()).toEqual(
      [...DollarThresholdTriggeredBySchema.options].sort(),
    );
    expect(Object.keys(budgetAlertThresholdClause)).not.toContain("RATE");
  });
});

describe("every clause figure is rounded through format-utils", () => {
  // Every figure renders through `format-utils.ts`, the one rounding source the
  // email and the console share. A second formatter would let the two round the
  // same number differently.
  test("the REPORTED clause rounds the threshold and the budget", () => {
    const clause = budgetAlertThresholdClause.REPORTED({
      ...detailPerTriggeredBy.REPORTED,
      budgetThresholdTriggered: 70.35000000000001,
      budget: 100.5,
    });

    expect(clause).toContain("USD 70.35");
    expect(clause).toContain("USD 100.50");
    // No bare `$`: it is the Canadian and Australian dollar sign too, and a clause
    // carrying one has interpolated a figure past the shared formatter.
    expect(clause).not.toContain("$");
    expect(clause).not.toContain("undefined");
  });

  test("the PREDICTED clause rounds the threshold and states an estimate", () => {
    const clause = budgetAlertThresholdClause.PREDICTED({
      ...detailPerTriggeredBy.PREDICTED,
      budgetThresholdTriggered: 70.5,
    });

    expect(clause).toContain("USD 70.50");
    expect(clause).toContain("estimate");
    expect(clause).not.toContain("reached");
    expect(clause).not.toContain("undefined");
  });

  test.each([
    ["HOURLY", "hour", "day"],
    ["DAILY", "day", "hour"],
  ] as const)(
    "the %s spend-rate alert body rounds the limit and measured rate in its basis unit",
    (rateBasis, unit, otherUnit) => {
      for (const body of spendRateAlertBodies({
        ...spendRateDetail,
        rateBasis,
        thresholdRate: 12.5,
        measuredRate: 13.456,
        totalSpend: 70.35000000000001,
      })) {
        expect(body).toContain(`spend rate limit of USD 12.50/${unit}`);
        expect(body).toContain(`the measured rate is USD 13.46/${unit}`);
        expect(body).toContain("The last confirmed cost was USD 70.35.");
        expect(body).not.toContain(`/${otherUnit}`);
        expect(body).not.toContain("$");
        expect(body).not.toContain("undefined");
      }
    },
  );
});

describe("the producer path puts no stored attribute on the bus", () => {
  test("a spread BREACH# row is stripped to the modelled detail", () => {
    // The producer emits from the row it just persisted, and a
    // spread of a variable gets no excess-property check -- so this compiles.
    // Unstripped, the row's storage attributes reach every rule target and any
    // archive; the consumer's own `parse` is too late to prevent that.
    const row = BreachRecordSchema.parse({
      leaseUuid: "750e8400-e29b-41d4-a716-446655440002",
      sk: "BREACH#2026-08-11T11:00:00.000Z",
      triggeredBy: "REPORTED",
      action: "ALERT",
      thresholdDollars: 70.0,
      thresholdRate: null,
      thresholdRateBasis: null,
      billedCostAtFire: 60.0,
      predictedCostAtFire: null,
      rateAtFire: null,
      rateSourceAtFire: null,
      evaluatedBy: "LEASE_MONITORING",
      evaluatedSpendAtFire: null,
      monitoredBedrockTokenCostAtFire: null,
      insight: null,
      ttl: futureTtl(),
      meta: { schemaVersion: LeaseCostHistorySchemaVersion },
    });

    const alert = new LeaseBudgetThresholdBreachedAlert({
      ...row,
      leaseId: { userEmail: "someone@example.com", uuid: row.leaseUuid },
      accountId: "123456789012",
      totalSpend: row.billedCostAtFire,
      budgetThresholdTriggered: row.thresholdDollars,
      actionRequested: row.action,
    } as unknown as ConstructorParameters<
      typeof LeaseBudgetThresholdBreachedAlert
    >[0]);

    for (const stored of [
      "leaseUuid",
      "sk",
      "ttl",
      "meta",
      "evaluatedBy",
      "action",
      "thresholdDollars",
      "billedCostAtFire",
      "evaluatedSpendAtFire",
      "monitoredBedrockTokenCostAtFire",
      "rateAtFire",
      "rateSourceAtFire",
      "predictedCostAtFire",
    ]) {
      expect(alert.Detail).not.toHaveProperty(stored);
    }
    // The projected fields survive, so this is stripping and not emptying.
    expect(alert.Detail.totalSpend).toBe(60.0);
    expect(alert.Detail.budgetThresholdTriggered).toBe(70.0);
    expect(alert.Detail.triggeredBy).toBe("REPORTED");
  });

  test.each([
    // Each fails a BRANCH rule, so the shape still parses and still strips.
    [
      "a PREDICTED breach missing its projection",
      { triggeredBy: "PREDICTED" as const, predictedCost: undefined },
    ],
    [
      "a REPORTED breach missing its dollar threshold",
      {
        triggeredBy: "REPORTED" as const,
        budgetThresholdTriggered: undefined,
      },
    ],
  ])("%s still strips the stored attributes", (_label, override) => {
    // The passing case above proves stripping only where it was never in doubt.
    // Zod strips on SUCCESS; a refinement failure yields no data at all, so this
    // is the path on which stripping actually matters.
    const alert = new LeaseBudgetThresholdBreachedAlert({
      leaseUuid: "750e8400-e29b-41d4-a716-446655440002",
      sk: "BREACH#2026-08-11T11:00:00.000Z",
      ttl: futureTtl(),
      meta: { schemaVersion: LeaseCostHistorySchemaVersion },
      evaluatedBy: "LEASE_MONITORING",
      evaluatedSpendAtFire: 81.500001,
      monitoredBedrockTokenCostAtFire: 12.25,
      leaseId: {
        userEmail: "someone@example.com",
        uuid: "750e8400-e29b-41d4-a716-446655440002",
      },
      accountId: "123456789012",
      totalSpend: 60.0,
      actionRequested: "ALERT",
      ...override,
    } as unknown as ConstructorParameters<
      typeof LeaseBudgetThresholdBreachedAlert
    >[0]);

    const serialized = JSON.stringify(alert.Detail);
    for (const stored of [
      "leaseUuid",
      "sk",
      "ttl",
      "meta",
      "evaluatedBy",
      "evaluatedSpendAtFire",
      "monitoredBedrockTokenCostAtFire",
    ]) {
      expect(alert.Detail).not.toHaveProperty(stored);
    }
    // The spend composition the threat model classes as business-sensitive.
    expect(serialized).not.toContain("81.5");
    expect(serialized).not.toContain("12.25");
  });

  test("a detail whose shape fails is still reduced to the modelled keys", () => {
    // No stripped output exists here, so the fallback projection is what runs.
    const alert = new LeaseBudgetThresholdBreachedAlert({
      leaseUuid: "750e8400-e29b-41d4-a716-446655440002",
      sk: "BREACH#2026-08-11T11:00:00.000Z",
      evaluatedSpendAtFire: 81.5,
      leaseId: { userEmail: "someone@example.com", uuid: "not-a-uuid" },
      accountId: "123456789012",
      totalSpend: 60.0,
      actionRequested: "ALERT",
      triggeredBy: "REPORTED",
      budgetThresholdTriggered: 70.0,
    } as unknown as ConstructorParameters<
      typeof LeaseBudgetThresholdBreachedAlert
    >[0]);

    expect(alert.Detail).not.toHaveProperty("leaseUuid");
    expect(alert.Detail).not.toHaveProperty("sk");
    expect(alert.Detail).not.toHaveProperty("evaluatedSpendAtFire");
    // Still carries what the consumer would have read.
    expect(alert.Detail.totalSpend).toBe(60.0);
  });
});

describe("a malformed emit is alarmable, not merely greppable", () => {
  const base = {
    leaseId: {
      userEmail: "someone@example.com",
      uuid: "750e8400-e29b-41d4-a716-446655440002",
    },
    accountId: "123456789012",
    totalSpend: 60,
    actionRequested: "ALERT" as const,
    budgetThresholdTriggered: 70,
  };

  test("the producer emits a subscribable log record naming the failing paths", () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    try {
      // Must not throw: determineLeaseEvents runs in an unguarded loop before
      // sendIsbEvents and the per-lease cost writes, so a throw here would
      // suppress the whole scan.
      new LeaseBudgetThresholdBreachedAlert({
        ...base,
        leaseId: { userEmail: "someone@example.com", uuid: "not-a-uuid" },
      });

      // Exact, not `expect.any(String)`: this record's logDetailType is a
      // SubscribableLogSchema member, and zod's message is a JSON dump of every
      // issue -- the UUID regex source and every failing attribute name. The
      // store's own parse warns carry it because they have no logDetailType and
      // are therefore not subscribable.
      expect(warn).toHaveBeenCalledWith(
        `${LogPatterns.DataValidationWarning.pattern}: emitting an invalid ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} detail`,
        expect.objectContaining({
          logDetailType: "InvalidEventDetailEmitted",
          eventDetailType: EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
          invalidPaths: ["leaseId.uuid"],
        }),
      );
      // The record must be one the log subscriber accepts, or the alarm never
      // sees it.
      expect(() =>
        SubscribableLogSchema.parse(warn.mock.calls[0]![1]),
      ).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  test("a valid detail emits no such record", () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    try {
      new LeaseBudgetThresholdBreachedAlert(base);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a freeze whose reason breaks the pairing rule is emitted and recorded", () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    try {
      // The freeze has already committed, so the event is built rather than
      // thrown away: an unsent notification leaves the user with a frozen
      // account and no reason for it.
      const frozen = new LeaseFrozenEvent({
        leaseId: base.leaseId,
        accountId: base.accountId,
        reason: {
          type: "BudgetExceeded",
          triggeredBudgetThreshold: 70,
          totalSpend: 72,
          triggeredBy: "PREDICTED",
        },
      } as unknown as ConstructorParameters<typeof LeaseFrozenEvent>[0]);

      expect(frozen.Detail.reason.type).toBe("BudgetExceeded");
      expect(warn).toHaveBeenCalledWith(
        `${LogPatterns.DataValidationWarning.pattern}: emitting an invalid ${EventDetailTypes.LeaseFrozen} detail`,
        expect.objectContaining({
          logDetailType: "InvalidEventDetailEmitted",
          eventDetailType: EventDetailTypes.LeaseFrozen,
          invalidPaths: ["reason.rateSource"],
        }),
      );
      expect(() =>
        SubscribableLogSchema.parse(warn.mock.calls[0]![1]),
      ).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  test("a malformed pre-freeze warning is emitted and recorded", () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    try {
      const warning = new LeaseFreezingThresholdBreachedAlert({
        leaseId: base.leaseId,
        accountId: base.accountId,
        reason: {
          type: "BudgetExceeded",
          triggeredBudgetThreshold: 70,
          totalSpend: 72,
          triggeredBy: "PREDICTED",
        },
      } as unknown as ConstructorParameters<
        typeof LeaseFreezingThresholdBreachedAlert
      >[0]);

      expect(warning.Detail.reason.type).toBe("BudgetExceeded");
      expect(warn).toHaveBeenCalledWith(
        `${LogPatterns.DataValidationWarning.pattern}: emitting an invalid ${EventDetailTypes.LeaseFreezingThresholdBreachedAlert} detail`,
        expect.objectContaining({
          logDetailType: "InvalidEventDetailEmitted",
          eventDetailType: EventDetailTypes.LeaseFreezingThresholdBreachedAlert,
          invalidPaths: ["reason.rateSource"],
        }),
      );
      expect(() =>
        SubscribableLogSchema.parse(warn.mock.calls[0]![1]),
      ).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the freeze events put no stored attribute on the bus either", () => {
  // The reason travels verbatim from the freezing alert through the lifecycle
  // manager into LeaseFrozenEvent, so a stored attribute picked up at either end
  // reaches the bus twice. Both constructors strip for that reason.
  const storedRow = {
    leaseUuid: "750e8400-e29b-41d4-a716-446655440002",
    sk: "BREACH#2026-08-11T11:00:00.000Z",
    ttl: futureTtl(),
    meta: { schemaVersion: LeaseCostHistorySchemaVersion },
    evaluatedBy: "LEASE_MONITORING",
    evaluatedSpendAtFire: 81.500001,
    monitoredBedrockTokenCostAtFire: 12.25,
  };

  test.each([
    [
      "LeaseFreezingThresholdBreachedAlert",
      LeaseFreezingThresholdBreachedAlert,
    ],
    ["LeaseFrozenEvent", LeaseFrozenEvent],
  ])("%s strips a reason spread from a stored row", (_label, Event) => {
    const event = new (Event as typeof LeaseFrozenEvent)({
      ...storedRow,
      leaseId: {
        userEmail: "someone@example.com",
        uuid: "750e8400-e29b-41d4-a716-446655440002",
      },
      accountId: "123456789012",
      reason: {
        ...storedRow,
        type: "BudgetExceeded",
        triggeredBudgetThreshold: 70.0,
        budget: 100.0,
        totalSpend: 60.0,
        triggeredBy: "REPORTED",
      },
    } as unknown as ConstructorParameters<typeof LeaseFrozenEvent>[0]);

    const serialized = JSON.stringify(event.Detail);
    for (const stored of Object.keys(storedRow)) {
      expect(event.Detail).not.toHaveProperty(stored);
      expect(event.Detail.reason).not.toHaveProperty(stored);
    }
    // The spend composition the threat model classes as business-sensitive.
    expect(serialized).not.toContain("81.5");
    expect(serialized).not.toContain("12.25");
    // Stripping, not emptying: the freeze still says why it fired.
    expect(event.Detail.reason).toMatchObject({
      type: "BudgetExceeded",
      triggeredBudgetThreshold: 70.0,
      totalSpend: 60.0,
    });
  });

  test("a reason failing the pairing rule is still stripped", () => {
    // Zod strips on SUCCESS, and the rateSource pairing is a superRefine, so this
    // is the path the shape schema exists for: a PREDICTED freeze with no rate
    // source yields no parsed data at all.
    const event = new LeaseFrozenEvent({
      ...storedRow,
      leaseId: {
        userEmail: "someone@example.com",
        uuid: "750e8400-e29b-41d4-a716-446655440002",
      },
      accountId: "123456789012",
      reason: {
        ...storedRow,
        type: "BudgetExceeded",
        triggeredBudgetThreshold: 70.0,
        totalSpend: 60.0,
        triggeredBy: "PREDICTED",
      },
    } as unknown as ConstructorParameters<typeof LeaseFrozenEvent>[0]);

    for (const stored of Object.keys(storedRow)) {
      expect(event.Detail).not.toHaveProperty(stored);
      expect(event.Detail.reason).not.toHaveProperty(stored);
    }
    expect(JSON.stringify(event.Detail)).not.toContain("81.5");
  });

  test("a reason whose type names no variant keeps none of its keys", () => {
    // The shape parse fails on the discriminator, so the fallback projection runs
    // and has no variant to project against. Better to emit an empty reason the
    // consumer rejects than the stored attributes it never reads.
    const event = new LeaseFrozenEvent({
      leaseId: {
        userEmail: "someone@example.com",
        uuid: "750e8400-e29b-41d4-a716-446655440002",
      },
      accountId: "123456789012",
      reason: { ...storedRow, type: "NotAFreezeReason", totalSpend: 60.0 },
    } as unknown as ConstructorParameters<typeof LeaseFrozenEvent>[0]);

    expect(event.Detail.reason).toEqual({});
    expect(event.Detail.accountId).toBe("123456789012");
  });
});
