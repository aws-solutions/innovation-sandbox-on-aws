// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ModelPricing,
  ModelPricingLookup,
  RegionModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/index.js";
import {
  accumulateTokenUsage,
  BedrockRate,
  BedrockRateSource,
  BedrockRateSourceServices,
  calculateEvaluatedSpend,
  computeLeaseFigures,
  createBedrockPricing,
  priceTokens,
  PriceTokensInput,
  RegionTokenUsage,
  remainderSeries,
  subtractTokens,
  TokenCumulative,
  validatedRateSource,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-token-cost/index.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  TokenCounts,
  UNATTRIBUTED_MODEL_ID,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";

// Locks the permanent contracts: with token monitoring off (null Bedrock
// terms, no data) evaluated spend IS the reported total and every
// Bedrock-aware rate is unavailable.

describe("calculateEvaluatedSpend", () => {
  it("equals the reported total while either Bedrock term is null", () => {
    expect(
      calculateEvaluatedSpend({
        billedCostAccrued: 17.5,
        billedBedrockTokenCost: null,
        monitoredBedrockTokenCost: null,
      }),
    ).toBe(17.5);
    expect(
      calculateEvaluatedSpend({
        billedCostAccrued: 17.5,
        billedBedrockTokenCost: 4,
        monitoredBedrockTokenCost: null,
      }),
    ).toBe(17.5);
  });

  it("swaps the billed Bedrock slice for the monitored one", () => {
    expect(
      calculateEvaluatedSpend({
        billedCostAccrued: 60,
        billedBedrockTokenCost: 20,
        monitoredBedrockTokenCost: 26,
      }),
    ).toBe(66);
  });

  // Counts lost to a gap CloudWatch has aged out leave the monitored term
  // short of the billed one, but the bill still holds that spend.
  it("never falls below the reported total where the monitored term is short of the billed one", () => {
    expect(
      calculateEvaluatedSpend({
        billedCostAccrued: 60,
        billedBedrockTokenCost: 20,
        monitoredBedrockTokenCost: 5,
      }),
    ).toBe(60);
  });
});

const costRows = [
  {
    timestamp: "2026-09-15T08:00:00.000Z",
    billedCostAccrued: 60,
    billedBedrockTokenCost: 20,
  },
  {
    timestamp: "2026-09-15T00:00:00.000Z",
    billedCostAccrued: 32,
    billedBedrockTokenCost: 8,
  },
];

describe("remainderSeries", () => {
  const rows = [
    ...costRows,
    {
      timestamp: "2026-09-14T16:00:00.000Z",
      billedCostAccrued: 18,
      billedBedrockTokenCost: null,
    },
  ];

  it("leaves out a row with no billed slice while a monitored term is swapped in, so both ends of a difference carry the same terms", () => {
    expect(remainderSeries(rows, true)).toEqual([
      { timestamp: "2026-09-15T08:00:00.000Z", billedCostAccrued: 40 },
      { timestamp: "2026-09-15T00:00:00.000Z", billedCostAccrued: 24 },
    ]);
  });

  it("differences on the billed total throughout without a monitored term, as an unmonitored lease is measured", () => {
    expect(remainderSeries(rows, false)).toBe(rows);
  });
});

// The worked example: two cost observations split by the usage-type query,
// the poll running at 11:00 with a monitored Bedrock figure of $26.00 that stood
// at $20.00 an hour earlier.
describe("computeLeaseFigures", () => {
  const monitored = {
    billedCostAccrued: 60,
    billedBedrockTokenCost: 20,
    monitoredBedrockTokenCost: 26,
    reportedAt: "2026-09-15T08:00:00.000Z",
    evaluatedAt: "2026-09-15T11:00:00.000Z",
    observations: costRows,
    bedrockWindows: { lastHour: 6, lastDay: null },
  };

  it("reproduces the worked example: evaluated 66.00, remainder 2.00 an hour, projected 72.00 at 11:00, Bedrock 6.00 an hour on the caps", () => {
    const figures = computeLeaseFigures(monitored);

    expect(figures.evaluatedSpend).toBe(66);
    expect(figures.monitoredBedrockTokenCost).toBe(26);
    expect(figures.rates.remainderHourlyRate).toBeCloseTo(2, 10);
    expect(figures.predictedCost).toBeCloseTo(72, 10);
    expect(figures.rates.bedrockHourlyRate).toBe(6);
    expect(figures.rates.summedHourlyRate).toBeCloseTo(8, 10);
    // the cost series is eight hours long, so no daily figure yet
    expect(figures.rates.summedDailyRate).toBeNull();
  });

  it("projects 70.50 for the same lease without monitoring, so the net movement is 1.50", () => {
    const unmonitored = computeLeaseFigures({
      ...monitored,
      billedBedrockTokenCost: null,
      monitoredBedrockTokenCost: null,
    });

    expect(unmonitored.evaluatedSpend).toBe(60);
    expect(unmonitored.predictedCost).toBeCloseTo(70.5, 10);
    expect(unmonitored.rates.summedHourlyRate).toBeCloseTo(3.5, 10);
    expect(unmonitored.rates.bedrockHourlyRate).toBeNull();
    expect(
      computeLeaseFigures(monitored).predictedCost - unmonitored.predictedCost,
    ).toBeCloseTo(1.5, 10);
  });

  // The one rule: without a monitored term to swap in, nothing is subtracted and
  // nothing is added, so the billed Bedrock accrual is still carried forward.
  it("measures an unpriced monitored term as an unmonitored lease: billed total, billed rate, nothing added", () => {
    const figures = computeLeaseFigures({
      ...monitored,
      monitoredBedrockTokenCost: null,
    });

    expect(figures.evaluatedSpend).toBe(60);
    expect(figures.monitoredBedrockTokenCost).toBeNull();
    expect(figures.predictedCost).toBeCloseTo(70.5, 10);
    expect(figures.rates.remainderHourlyRate).toBeCloseTo(3.5, 10);
    expect(figures.rates.summedHourlyRate).toBeCloseTo(3.5, 10);
    expect(figures.rates.bedrockHourlyRate).toBeNull();
  });

  it("does the same when the newest observation's own slice is unknown", () => {
    const figures = computeLeaseFigures({
      ...monitored,
      billedBedrockTokenCost: null,
    });

    expect(figures.evaluatedSpend).toBe(60);
    // the priced term exists but was not substituted, so it is not reported as such
    expect(figures.monitoredBedrockTokenCost).toBeNull();
    expect(figures.rates.summedHourlyRate).toBeCloseTo(3.5, 10);
    expect(figures.rates.bedrockHourlyRate).toBeNull();
  });

  it("carries the billed total forward where the monitored term is short of the billed slice, keeping the Bedrock rate on the caps", () => {
    const figures = computeLeaseFigures({
      ...monitored,
      monitoredBedrockTokenCost: 5,
      bedrockWindows: { lastHour: 3, lastDay: null },
    });

    expect(figures.evaluatedSpend).toBe(60);
    expect(figures.monitoredBedrockTokenCost).toBe(5);
    // 60.00 carried 3h at the 2.00 remainder rate
    expect(figures.predictedCost).toBeCloseTo(66, 10);
    expect(figures.rates.bedrockHourlyRate).toBe(3);
    expect(figures.rates.summedHourlyRate).toBeCloseTo(5, 10);
  });

  it("moves by exactly the remainder rate times ten minutes on each poll with no new data, and never compounds", () => {
    const polls = [0, 10, 20, 30, 40, 50].map(
      (minutes) =>
        computeLeaseFigures({
          ...monitored,
          evaluatedAt: `2026-09-15T11:${String(minutes).padStart(2, "0")}:00.000Z`,
        }).predictedCost,
    );

    for (let i = 1; i < polls.length; i++) {
      expect(polls[i]! - polls[i - 1]!).toBeCloseTo(2 / 6, 10);
    }
    expect(polls[5]).toBeCloseTo(72 + (2 * 50) / 60, 10);
  });

  it("holds flat once the elapsed time reaches the reporting interval", () => {
    const atCap = computeLeaseFigures({
      ...monitored,
      evaluatedAt: "2026-09-15T16:00:00.000Z",
    });
    const pastCap = computeLeaseFigures({
      ...monitored,
      evaluatedAt: "2026-09-15T20:00:00.000Z",
    });

    expect(atCap.predictedCost).toBeCloseTo(66 + 2 * 8, 10);
    expect(pastCap.predictedCost).toBe(atCap.predictedCost);
  });

  it("reports the window's monitored Bedrock dollars as the Bedrock rate and adds them to the remainder's", () => {
    // idle since last night, $60.00 spent in the last ten minutes
    const figures = computeLeaseFigures({
      ...monitored,
      monitoredBedrockTokenCost: 100,
      bedrockWindows: { lastHour: 60, lastDay: 60 },
    });

    expect(figures.rates.bedrockHourlyRate).toBe(60);
    expect(figures.rates.summedHourlyRate).toBeCloseTo(62, 10);
  });

  it("is unmeasurable, not zero, where the earlier figure is unknown", () => {
    const figures = computeLeaseFigures({
      ...monitored,
      bedrockWindows: { lastHour: null, lastDay: null },
    });

    expect(figures.rates.bedrockHourlyRate).toBeNull();
    expect(figures.rates.summedHourlyRate).toBeNull();
    expect(figures.rates.summedDailyRate).toBeNull();
  });

  it("reports the daily figure in dollars per day and adds it to the remainder's", () => {
    const figures = computeLeaseFigures({
      ...monitored,
      observations: [
        ...costRows,
        {
          timestamp: "2026-09-14T08:00:00.000Z",
          billedCostAccrued: 16,
          billedBedrockTokenCost: 6,
        },
      ],
      bedrockWindows: { lastHour: 6, lastDay: 26 },
    });

    // (40 - 10) over a day on the billed side, the whole $26.00 on the
    // monitored side
    expect(figures.rates.remainderDailyRate).toBeCloseTo(30, 10);
    expect(figures.rates.summedDailyRate).toBeCloseTo(56, 10);
  });

  it("is evaluated spend with no remainder rate to carry forward", () => {
    const figures = computeLeaseFigures({ ...monitored, observations: [] });

    expect(figures.predictedCost).toBe(66);
    expect(figures.rates.remainderHourlyRate).toBeNull();
    expect(figures.rates.summedHourlyRate).toBeNull();
  });
});

const services: BedrockRateSourceServices = {
  logger: new Logger({ serviceName: "test" }),
};

/** A source that hands back the same rate for every lookup. */
function fixedRateSource(rate: BedrockRate) {
  return validatedRateSource(() => rate, services);
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  vi.spyOn(Logger.prototype, "info").mockImplementation(() => {});
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.resetAllMocks();
});

const LEASE_ID = "lease-1";
const NOVA = "amazon.nova-pro-v1:0";
const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const PER_THOUSAND = 1_000;
const PER_MILLION = 1_000_000;

const counts = (partial: Partial<TokenCounts>): TokenCounts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  ...partial,
});

/** A published source with one rate per `region/modelId/tokenType`, null elsewhere. */
function tableSource(rates: Record<string, BedrockRate>): BedrockRateSource {
  return validatedRateSource(
    (region, modelId, tokenType) =>
      rates[`${region}/${modelId}/${tokenType}`] ?? null,
    services,
  );
}

/** A source with no rate for anything. */
const noRates = (): BedrockRateSource => () => null;

function price(input: Partial<PriceTokensInput>) {
  return priceTokens({
    leaseId: LEASE_ID,
    tokens: {},
    rates: noRates(),
    logger: services.logger,
    ...input,
  });
}

describe("priceTokens", () => {
  it("prices no counts, and counts with no rate, as 0", () => {
    expect(price({ tokens: {} })).toBe(0);
    expect(
      price({
        tokens: { "us-east-1": { [NOVA]: counts({ input: 1_000 }) } },
      }),
    ).toBe(0);
  });

  it("prices a per-million product a thousand times lower than the same counts per thousand", () => {
    const tokens = { "us-east-1": { [NOVA]: counts({ input: 2_000_000 }) } };

    const perThousand = price({
      tokens,
      rates: fixedRateSource({ ratePerUnit: 0.03, unitDivisor: PER_THOUSAND }),
    });
    const perMillion = price({
      tokens,
      rates: fixedRateSource({ ratePerUnit: 0.03, unitDivisor: PER_MILLION }),
    });

    expect(perThousand).toBeCloseTo(60, 6);
    expect(perMillion).toBeCloseTo(0.06, 6);
  });

  it("sums every slice across regions, models and token types at each one's own rate", () => {
    const cost = price({
      tokens: {
        "us-east-1": {
          [NOVA]: counts({ input: 1_000, output: 1_000_000 }),
          [HAIKU]: counts({ output: 500_000 }),
        },
        "us-west-2": { [NOVA]: counts({ input: 1_000 }) },
      },
      rates: tableSource({
        [`us-east-1/${NOVA}/input`]: { ratePerUnit: 0.8, unitDivisor: 1_000 },
        [`us-east-1/${NOVA}/output`]: { ratePerUnit: 2.4, unitDivisor: 1e6 },
        [`us-east-1/${HAIKU}/output`]: { ratePerUnit: 4, unitDivisor: 1e6 },
        [`us-west-2/${NOVA}/input`]: { ratePerUnit: 1, unitDivisor: 1_000 },
      }),
    });

    // 0.8 + 2.4 + 2 + 1
    expect(cost).toBeCloseTo(6.2, 6);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  // A $0 rate is a free SKU: it prices its slice as free without the warning a
  // missing rate logs.
  it("prices counts whose only rate is $0 as 0 rather than as unpriced", () => {
    const cost = price({
      tokens: { "us-east-1": { [NOVA]: counts({ cacheWrite: 1_000 }) } },
      rates: fixedRateSource({ ratePerUnit: 0, unitDivisor: PER_MILLION }),
    });

    expect(cost).toBe(0);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it("sums only the priced slices where a $0 slice sits alongside them", () => {
    const cost = price({
      tokens: {
        "us-east-1": {
          [NOVA]: counts({ input: 1_000_000, cacheWrite: 1_000_000 }),
        },
      },
      rates: tableSource({
        [`us-east-1/${NOVA}/input`]: { ratePerUnit: 0.8, unitDivisor: 1e6 },
        [`us-east-1/${NOVA}/cacheWrite`]: { ratePerUnit: 0, unitDivisor: 1e6 },
      }),
    });

    expect(cost).toBeCloseTo(0.8, 6);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it("sums only the priced slices where some counted slices have no rate, naming those once", () => {
    const cost = price({
      tokens: {
        "us-east-1": {
          [NOVA]: counts({ input: 1_000, cacheWrite: 10 }),
          [HAIKU]: counts({ output: 500, cacheRead: 20 }),
        },
      },
      rates: tableSource({
        [`us-east-1/${NOVA}/input`]: { ratePerUnit: 0.8, unitDivisor: 1_000 },
      }),
    });

    // the 1,000 Nova input tokens alone
    expect(cost).toBeCloseTo(0.8, 6);
    // One entry per counted slice, count included so the gap can be sized; a
    // type with no counts (Nova output) is not among them.
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.BedrockTokensUnpriced.pattern),
      {
        leaseId: LEASE_ID,
        unpriced: expect.arrayContaining([
          {
            region: "us-east-1",
            modelId: NOVA,
            tokenType: "cacheWrite",
            count: 10,
          },
          {
            region: "us-east-1",
            modelId: HAIKU,
            tokenType: "output",
            count: 500,
          },
          {
            region: "us-east-1",
            modelId: HAIKU,
            tokenType: "cacheRead",
            count: 20,
          },
        ]),
      },
    );
    const [, detail] = vi.mocked(Logger.prototype.warn).mock.calls[0]!;
    expect((detail as { unpriced: unknown[] }).unpriced).toHaveLength(3);
  });

  it("lets a throwing rate source fail the call rather than pricing around it", () => {
    expect(() =>
      price({
        tokens: { "us-east-1": { [NOVA]: counts({ input: 1_000 }) } },
        rates: () => {
          throw new Error("price cache unavailable");
        },
      }),
    ).toThrow("price cache unavailable");
  });

  it("leaves counts attributed to no model out of the price without blocking the rest", () => {
    const source = vi.fn((): BedrockRate => ({
      ratePerUnit: 3,
      unitDivisor: PER_MILLION,
    }));
    const tokens = {
      "us-east-1": {
        [NOVA]: counts({ input: 1_000 }),
        [UNATTRIBUTED_MODEL_ID]: counts({ input: 1_000 }),
      },
    };

    const cost = price({
      tokens,
      rates: validatedRateSource(source, services),
    });

    // Nova alone; the source is never asked to price a key that is not a model
    expect(cost).toBeCloseTo(0.003, 6);
    expect(source).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledWith("us-east-1", NOVA, "input");
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
    // and with nothing else to price, the counts cost nothing
    expect(
      price({
        tokens: {
          "us-east-1": { [UNATTRIBUTED_MODEL_ID]: counts({ input: 1_000 }) },
        },
        rates: validatedRateSource(source, services),
      }),
    ).toBe(0);
  });
});

const T0 = "2026-09-15T10:00:00.000Z";
const T1 = "2026-09-15T11:55:00.000Z";

function regionReading(
  region: string,
  leases: RegionTokenUsage["leases"],
): RegionTokenUsage {
  return { region, leases };
}

describe("accumulateTokenUsage", () => {
  const previous: TokenCumulative = {
    tokens: {
      "us-east-1": { [NOVA]: counts({ input: 5, output: 1 }) },
      "us-west-2": { [HAIKU]: counts({ input: 7 }) },
      "eu-west-1": { [NOVA]: counts({ output: 3 }) },
    },
    coveredThrough: { "us-east-1": T0, "us-west-2": T0, "eu-west-1": T0 },
  };

  it("starts a lease's cumulative from its first reading", () => {
    const cumulative = accumulateTokenUsage(LEASE_ID, null, [
      regionReading("us-east-1", {
        [LEASE_ID]: {
          tokens: { [NOVA]: counts({ input: 5 }) },
          coveredThrough: T1,
        },
      }),
    ]);

    expect(cumulative).toEqual({
      tokens: { "us-east-1": { [NOVA]: counts({ input: 5 }) } },
      coveredThrough: { "us-east-1": T1 },
    });
  });

  it("adds each region's reading to the stored counts and moves that region's anchor", () => {
    const cumulative = accumulateTokenUsage(LEASE_ID, previous, [
      regionReading("us-east-1", {
        [LEASE_ID]: {
          tokens: {
            [NOVA]: counts({ input: 3, cacheRead: 2 }),
            [HAIKU]: counts({ output: 4 }),
          },
          coveredThrough: T1,
        },
      }),
      regionReading("us-west-2", {
        [LEASE_ID]: {
          tokens: { [HAIKU]: counts({ input: 1 }) },
          coveredThrough: T1,
        },
      }),
    ]);

    expect(cumulative).toEqual({
      tokens: {
        "us-east-1": {
          [NOVA]: counts({ input: 8, output: 1, cacheRead: 2 }),
          [HAIKU]: counts({ output: 4 }),
        },
        "us-west-2": { [HAIKU]: counts({ input: 8 }) },
        "eu-west-1": { [NOVA]: counts({ output: 3 }) },
      },
      coveredThrough: { "us-east-1": T1, "us-west-2": T1, "eu-west-1": T0 },
    });
  });

  // The anchor is what the next window is read from, so a region that was not
  // read must keep it: advancing it would skip the buckets that were missed.
  it("holds the counts and anchor of a region with no reading for the lease", () => {
    const cumulative = accumulateTokenUsage(LEASE_ID, previous, [
      regionReading("us-east-1", {
        [LEASE_ID]: {
          tokens: { [NOVA]: counts({ input: 3 }) },
          coveredThrough: T1,
        },
      }),
      // the region was read, but this lease was idle there
      regionReading("us-west-2", {
        "other-lease": {
          tokens: { [HAIKU]: counts({ input: 1 }) },
          coveredThrough: T1,
        },
      }),
      // eu-west-1 failed, so it is not in the list at all
    ]);

    expect(cumulative).toEqual({
      tokens: {
        "us-east-1": { [NOVA]: counts({ input: 8, output: 1 }) },
        "us-west-2": { [HAIKU]: counts({ input: 7 }) },
        "eu-west-1": { [NOVA]: counts({ output: 3 }) },
      },
      coveredThrough: { "us-east-1": T1, "us-west-2": T0, "eu-west-1": T0 },
    });
  });

  it("returns null when no region read anything for the lease", () => {
    expect(
      accumulateTokenUsage(LEASE_ID, previous, [
        regionReading("us-east-1", {}),
        regionReading("us-west-2", {
          "other-lease": {
            tokens: { [HAIKU]: counts({ input: 1 }) },
            coveredThrough: T1,
          },
        }),
      ]),
    ).toBeNull();
  });

  it("leaves the stored cumulative untouched", () => {
    const before = structuredClone(previous);

    accumulateTokenUsage(LEASE_ID, previous, [
      regionReading("us-east-1", {
        [LEASE_ID]: {
          tokens: { [NOVA]: counts({ input: 3 }) },
          coveredThrough: T1,
        },
      }),
    ]);

    expect(previous).toEqual(before);
  });
});

describe("subtractTokens", () => {
  it("keeps only the slices that moved, per region, model and token type", () => {
    const moved = subtractTokens(
      {
        "us-east-1": {
          [NOVA]: counts({ input: 26_000, output: 400 }),
          [HAIKU]: counts({ input: 100 }),
        },
        "us-west-2": { [NOVA]: counts({ input: 50 }) },
      },
      {
        "us-east-1": {
          [NOVA]: counts({ input: 20_000, output: 400 }),
          [HAIKU]: counts({ input: 100 }),
        },
      },
    );

    expect(moved).toEqual({
      "us-east-1": { [NOVA]: counts({ input: 6_000 }) },
      "us-west-2": { [NOVA]: counts({ input: 50 }) },
    });
  });

  it("reads a count that fell as nothing moved, never as negative usage", () => {
    expect(
      subtractTokens(
        { "us-east-1": { [NOVA]: counts({ input: 10 }) } },
        { "us-east-1": { [NOVA]: counts({ input: 12 }) } },
      ),
    ).toEqual({});
  });
});

describe("createBedrockPricing", () => {
  const claude = "anthropic.claude-sonnet-4";
  const nova = "amazon.nova-pro";
  const pricing = (
    input: number,
    pricingSource: ModelPricing["pricingSource"] = "price-list",
  ): ModelPricing => ({
    inputPricePer1KTokens: input,
    outputPricePer1KTokens: input * 5,
    cacheReadPricePer1KTokens: input / 10,
    cacheWritePricePer1KTokens: input * 1.25,
    pricingSource,
  });

  /** A lookup that returns `priceFor(modelId, region)` for each model looked up. */
  const lookupFrom =
    (
      priceFor: (modelId: string, region: string) => ModelPricing | undefined,
    ): ModelPricingLookup =>
    async (models) => {
      const found = new Map<string, Map<string, ModelPricing>>();
      for (const { region, modelId } of models) {
        const price = priceFor(modelId, region);
        if (price !== undefined) {
          const byModel = found.get(region) ?? new Map();
          found.set(region, byModel.set(modelId, price));
        }
      }
      return found;
    };

  /** The models as used in us-east-1. */
  const inEast = (...modelIds: string[]): RegionModel[] =>
    modelIds.map((modelId) => ({ region: "us-east-1", modelId }));

  /** A lookup result holding these prices for the model in us-east-1. */
  const eastPrices = (modelId: string, price: ModelPricing) =>
    new Map([["us-east-1", new Map([[modelId, price]])]]);

  function published(modelPricing: ModelPricingLookup) {
    return createBedrockPricing({ ...services, modelPricing });
  }

  it("prices each token type from the looked-up model, per thousand tokens", async () => {
    const lookup = vi.fn(lookupFrom(() => pricing(0.003)));
    const rates = published(lookup);
    await rates.loadPrices(inEast(claude));

    expect(lookup).toHaveBeenCalledWith([
      { region: "us-east-1", modelId: "anthropic.claude-sonnet-4" },
    ]);
    const expected = {
      input: 0.003,
      output: 0.015,
      cacheRead: 0.0003,
      cacheWrite: 0.00375,
    };
    for (const [tokenType, ratePerUnit] of Object.entries(expected)) {
      expect(
        rates.source(
          "us-east-1",
          "anthropic.claude-sonnet-4",
          tokenType as keyof typeof expected,
        ),
      ).toEqual({
        ratePerUnit: expect.closeTo(ratePerUnit, 12),
        unitDivisor: 1_000,
      });
    }
    // a model never passed to loadPrices has no price
    expect(rates.source("us-east-1", "meta.llama3-70b", "input")).toBeNull();
  });

  it("prices a token type the source publishes at $0 as free, not as unpriced", async () => {
    const rates = published(
      lookupFrom(() => ({ ...pricing(0.003), cacheWritePricePer1KTokens: 0 })),
    );
    await rates.loadPrices(inEast(claude));

    expect(
      rates.source("us-east-1", "anthropic.claude-sonnet-4", "cacheWrite"),
    ).toEqual({ ratePerUnit: 0, unitDivisor: 1_000 });
  });

  it("looks up nothing when a run has no models to price", async () => {
    const lookup = vi.fn(lookupFrom(() => pricing(0.003)));
    expect(await published(lookup).loadPrices([])).toBe(true);

    expect(lookup).not.toHaveBeenCalled();
  });

  it("leaves a model unpriced that was not loaded in the region or has no price", async () => {
    const rates = published(lookupFrom(() => undefined));
    await rates.loadPrices([
      { region: "us-east-1", modelId: claude },
      { region: "us-west-2", modelId: nova },
    ]);

    expect(
      rates.source("us-east-1", "anthropic.claude-sonnet-4", "input"),
    ).toBeNull();
    expect(rates.source("us-west-2", "amazon.nova-pro", "input")).toBeNull();
    expect(rates.source("eu-west-1", "amazon.nova-pro", "input")).toBeNull();
  });

  it("drops a real price outside the plausible range rather than pricing from it", async () => {
    const rates = published(lookupFrom(() => pricing(3)));
    await rates.loadPrices(inEast(claude));

    expect(
      rates.source("us-east-1", "anthropic.claude-sonnet-4", "input"),
    ).toBeNull();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.DataValidationWarning.pattern),
      expect.objectContaining({ modelId: "anthropic.claude-sonnet-4" }),
    );
  });

  it("looks up every loaded region and model in one call per run, and prices a model at each region's own rate", async () => {
    const regionalRates: Record<string, number> = {
      "us-east-1": 0.0008,
      "ap-southeast-1": 0.00108,
    };
    const lookup = vi.fn(
      lookupFrom((_modelId, region) => pricing(regionalRates[region]!)),
    );
    const rates = published(lookup);
    const models = [
      { region: "us-east-1", modelId: nova },
      { region: "ap-southeast-1", modelId: nova },
      { region: "us-east-1", modelId: claude },
    ];

    expect(await rates.loadPrices(models)).toBe(true);

    expect(lookup.mock.calls).toEqual([[models]]);
    for (const [region, ratePerUnit] of Object.entries(regionalRates)) {
      expect(rates.source(region, "amazon.nova-pro", "input")).toEqual({
        ratePerUnit,
        unitDivisor: 1_000,
      });
    }
    // a region the model was not loaded in has no price for it
    expect(rates.source("us-west-2", "amazon.nova-pro", "input")).toBeNull();
  });

  it("looks the models up again on every run, keeping no price from an earlier run", async () => {
    const lookup = vi
      .fn<ModelPricingLookup>()
      .mockResolvedValueOnce(eastPrices(claude, pricing(0.003)))
      .mockResolvedValueOnce(new Map());
    const rates = published(lookup);

    await rates.loadPrices(inEast(claude));
    expect(
      rates.source("us-east-1", "anthropic.claude-sonnet-4", "input"),
    ).toEqual({ ratePerUnit: 0.003, unitDivisor: 1_000 });

    await rates.loadPrices(inEast(claude));
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(
      rates.source("us-east-1", "anthropic.claude-sonnet-4", "input"),
    ).toBeNull();
  });

  it("resolves false and leaves the run's models unpriced when the lookup fails, and looks them up again next run", async () => {
    const lookup = vi
      .fn<ModelPricingLookup>()
      .mockRejectedValueOnce(new Error("throttled"))
      .mockResolvedValue(eastPrices(claude, pricing(0.003)));
    const rates = published(lookup);

    expect(await rates.loadPrices(inEast(claude))).toBe(false);
    expect(
      rates.source("us-east-1", "anthropic.claude-sonnet-4", "input"),
    ).toBeNull();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining("model pricing lookup failed"),
      expect.objectContaining({
        models: [{ region: "us-east-1", modelId: "anthropic.claude-sonnet-4" }],
      }),
    );

    expect(await rates.loadPrices(inEast(claude))).toBe(true);
    expect(
      rates.source("us-east-1", "anthropic.claude-sonnet-4", "input"),
    ).toEqual({
      ratePerUnit: 0.003,
      unitDivisor: 1_000,
    });
  });

  it("drops the previous run's prices when the lookup fails", async () => {
    const lookup = vi
      .fn<ModelPricingLookup>()
      .mockResolvedValueOnce(eastPrices(claude, pricing(0.003)))
      .mockRejectedValueOnce(new Error("throttled"));
    const rates = published(lookup);

    await rates.loadPrices(inEast(claude));
    expect(
      rates.source("us-east-1", "anthropic.claude-sonnet-4", "input"),
    ).toEqual({ ratePerUnit: 0.003, unitDivisor: 1_000 });

    expect(await rates.loadPrices(inEast(claude))).toBe(false);
    expect(
      rates.source("us-east-1", "anthropic.claude-sonnet-4", "input"),
    ).toBeNull();
  });
});

describe("validatedRateSource", () => {
  // The per-token band is inclusive, and a $0 rate is a free SKU that the
  // band does not apply to.
  it.each([
    ["the per-token ceiling", { ratePerUnit: 1, unitDivisor: 1_000 }],
    ["the per-token floor", { ratePerUnit: 0.001, unitDivisor: 1_000_000 }],
    ["a free rate per thousand", { ratePerUnit: 0, unitDivisor: 1_000 }],
    ["a free rate per million", { ratePerUnit: 0, unitDivisor: 1_000_000 }],
  ])("accepts %s", (_case, rate) => {
    expect(
      fixedRateSource(rate)("us-east-1", "amazon.nova-pro", "input"),
    ).toEqual(rate);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  // The reason is asserted per case, not just the fact of a warning: otherwise
  // the branches of rejectionReason are indistinguishable and any one of them
  // could stop firing unnoticed.
  it.each([
    [
      "an unknown pricing unit",
      { ratePerUnit: 0.003, unitDivisor: 100 },
      "unitDivisor is not a Bedrock pricing unit",
    ],
    [
      "a negative rate",
      { ratePerUnit: -0.003, unitDivisor: 1_000 },
      "ratePerUnit is negative or not a finite number",
    ],
    [
      "a NaN rate",
      { ratePerUnit: Number.NaN, unitDivisor: 1_000 },
      "ratePerUnit is negative or not a finite number",
    ],
    [
      "an infinite rate",
      { ratePerUnit: Number.POSITIVE_INFINITY, unitDivisor: 1_000 },
      "ratePerUnit is negative or not a finite number",
    ],
    [
      "a per-million price read per thousand",
      { ratePerUnit: 75, unitDivisor: 1_000 },
      "price per token is outside the plausible Bedrock range",
    ],
    [
      "a price below the per-token floor",
      { ratePerUnit: 0.0005, unitDivisor: 1_000_000 },
      "price per token is outside the plausible Bedrock range",
    ],
  ])("rejects %s and warns", (_case, rate, rejection) => {
    expect(
      fixedRateSource(rate)("us-east-1", "amazon.nova-pro", "input"),
    ).toBeNull();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.DataValidationWarning.pattern),
      expect.objectContaining({ modelId: "amazon.nova-pro", rejection }),
    );
  });

  it("does not warn when the source itself has no rate", () => {
    expect(
      validatedRateSource(() => null, services)(
        "us-east-1",
        "amazon.nova-pro",
        "input",
      ),
    ).toBeNull();
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });
});
