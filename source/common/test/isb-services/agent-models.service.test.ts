// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  BedrockClient,
  GetFoundationModelCommand,
  GetInferenceProfileCommand,
  ListFoundationModelAgreementOffersCommand,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  ResourceNotFoundException,
  ThrottlingException,
  ValidationException,
} from "@aws-sdk/client-bedrock";
import { GetProductsCommand, PricingClient } from "@aws-sdk/client-pricing";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchAgentModelsWithPricing,
  resolveEligibleAgentModel,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.service.js";
import { FetchAgentModelsWithPricingServices } from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.types.js";
import {
  LiveModelRates,
  PricingModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/bedrock-model-catalog.types.js";
import {
  fetchPublishedModelRates,
  resolveModelPricing,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/price-fetching.js";

const mockBedrock = mockClient(BedrockClient);
const mockPricing = mockClient(PricingClient);

const logger = new Logger({ serviceName: "test" });

function makeServices(): FetchAgentModelsWithPricingServices {
  return {
    bedrockClient: new BedrockClient({}) as unknown as BedrockClient,
    pricingClient: new PricingClient({}) as unknown as PricingClient,
    region: "us-east-1",
    logger,
    // A price cache holding nothing, which accepts what is saved to it.
    priceCache: {
      getPrices: vi.fn(async () => []),
      putPrices: vi.fn(async () => {}),
    },
  };
}

/** The live rates fetched for the given models, by model ID. */
async function fetchPricingForModels(
  props: { models: PricingModel[] },
  services: FetchAgentModelsWithPricingServices,
) {
  return (await fetchPublishedModelRates(props, services)).rates;
}

/** Prices models and fills in the rates that were not published. */
async function priceModels(models: PricingModel[]) {
  const rates = await fetchPricingForModels({ models }, makeServices());
  return models.map((model) => resolveModelPricing(rates.get(model.modelId)));
}

function eligibleFoundationModel(overrides = {}) {
  return {
    modelId: "anthropic.claude-sonnet-4-6",
    modelName: "Claude Sonnet 4.6",
    providerName: "Anthropic",
    inputModalities: ["TEXT"],
    outputModalities: ["TEXT"],
    responseStreamingSupported: true,
    inferenceTypesSupported: ["ON_DEMAND"],
    modelLifecycle: { status: "ACTIVE" },
    ...overrides,
  } as any;
}

function eligibleInferenceProfile(overrides = {}) {
  return {
    inferenceProfileId: "global.anthropic.claude-sonnet-4-6",
    inferenceProfileName: "Claude Sonnet 4.6 Global",
    status: "ACTIVE",
    type: "SYSTEM_DEFINED",
    // Must reference at least one foundation model that passed eligibility.
    models: [
      {
        modelArn:
          "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
      },
    ],
    ...overrides,
  } as any;
}

/** Builds a minimal pricing:GetProducts PriceList entry for a given model.
 * `usageType` must end with one of the four standard suffixes used by
 * `USAGE_TYPE_SUFFIX_MAP` (e.g. "USE1-NovaPro-input-tokens"). */
function priceListEntry(
  modelName: string,
  usageType: string,
  usdPricePerUnit: number,
  unit = "1K tokens",
): string {
  return JSON.stringify({
    product: {
      attributes: {
        model: modelName,
        usagetype: usageType,
      },
    },
    terms: {
      OnDemand: {
        term1: {
          priceDimensions: {
            dim1: {
              unit,
              pricePerUnit: { USD: String(usdPricePerUnit) },
            },
          },
        },
      },
    },
  });
}

/** Builds a minimal ListFoundationModelAgreementOffers offer with $/Million-token rates.
 * `isGlobal` controls whether dimension keys use the `_Global` suffix. */
function agreementOffer(
  rates: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  },
  isGlobal = false,
) {
  const suffix = isGlobal ? "_Global" : "";
  const rateCard = [];
  if (rates.input !== undefined)
    rateCard.push({
      dimension: `USE1_InputTokenCount${suffix}`,
      price: String(rates.input),
    });
  if (rates.output !== undefined)
    rateCard.push({
      dimension: `USE1_OutputTokenCount${suffix}`,
      price: String(rates.output),
    });
  if (rates.cacheRead !== undefined)
    rateCard.push({
      dimension: `USE1_CacheReadInputTokenCount${suffix}`,
      price: String(rates.cacheRead),
    });
  if (rates.cacheWrite !== undefined)
    rateCard.push({
      dimension: `USE1_CacheWriteInputTokenCount${suffix}`,
      price: String(rates.cacheWrite),
    });
  return {
    offers: [
      {
        offerToken: "tok",
        termDetails: {
          usageBasedPricingTerm: { rateCard },
          legalTerm: {},
          supportTerm: {},
        },
      },
    ],
  };
}

describe("fetchAgentModelsWithPricing", () => {
  beforeEach(() => {
    mockBedrock.reset();
    mockPricing.reset();
    vi.resetAllMocks();
    // Default: agreement offers returns no rates (tests that need rates override this).
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand)
      .resolves({ offers: [] });
    // Default: GetProducts returns no results.
    mockPricing.on(GetProductsCommand).resolves({ PriceList: [] });
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns only active, streaming TEXT-input + ON_DEMAND foundation models that don't output speech", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel(),
        eligibleFoundationModel({
          modelId: "amazon.nova-2-sonic-v1:0",
          inputModalities: ["SPEECH"],
        }),
        eligibleFoundationModel({
          modelId: "amazon.nova-2-5-sonic",
          inputModalities: ["SPEECH", "TEXT"],
          outputModalities: ["SPEECH", "TEXT"],
        }),
        eligibleFoundationModel({
          modelId: "mistral.voxtral-mini-3b-2507",
          inputModalities: ["SPEECH", "TEXT"],
        }),
        eligibleFoundationModel({
          modelId: "nonstreaming.model",
          responseStreamingSupported: false,
        }),
        eligibleFoundationModel({
          modelId: "legacy.model",
          modelLifecycle: { status: "LEGACY" },
        }),
        eligibleFoundationModel({
          modelId: "embed.model",
          inferenceTypesSupported: [],
        }),
      ],
    });
    mockBedrock
      .on(ListInferenceProfilesCommand)
      .resolves({ inferenceProfileSummaries: [] });

    const result = await fetchAgentModelsWithPricing(makeServices());
    expect(
      mockBedrock.commandCalls(ListFoundationModelsCommand)[0]!.args[0].input,
    ).toEqual({ byOutputModality: "TEXT" });
    expect(result.models.map((m) => m.modelId)).toEqual([
      "anthropic.claude-sonnet-4-6",
      "mistral.voxtral-mini-3b-2507",
    ]);
  });

  it("includes both foundation models and inference profiles", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [eligibleFoundationModel()],
    });
    mockBedrock.on(ListInferenceProfilesCommand).resolves({
      inferenceProfileSummaries: [eligibleInferenceProfile()],
    });

    const result = await fetchAgentModelsWithPricing(makeServices());
    expect(result.models).toHaveLength(2);
  });

  it("deduplicates by modelId — global and regional profiles are separate entries", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel({ modelId: "anthropic.claude-3" }),
        eligibleFoundationModel({ modelId: "anthropic.claude-3" }), // duplicate
      ],
    });
    const profileArn =
      "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3";
    mockBedrock.on(ListInferenceProfilesCommand).resolves({
      inferenceProfileSummaries: [
        eligibleInferenceProfile({
          inferenceProfileId: "global.anthropic.claude-3",
          models: [{ modelArn: profileArn }],
        }),
        eligibleInferenceProfile({
          inferenceProfileId: "us.anthropic.claude-3",
          models: [{ modelArn: profileArn }],
        }),
      ],
    });

    const result = await fetchAgentModelsWithPricing(makeServices());
    // 1 foundation (deduped) + 2 inference profiles (distinct IDs)
    expect(result.models).toHaveLength(3);
  });

  it("derives availability for global inference profiles", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel({ modelId: "anthropic.claude-3" }),
      ],
    });
    mockBedrock.on(ListInferenceProfilesCommand).resolves({
      inferenceProfileSummaries: [
        eligibleInferenceProfile({
          inferenceProfileId: "global.anthropic.claude-3",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3",
            },
          ],
        }),
      ],
    });

    const result = await fetchAgentModelsWithPricing(makeServices());
    const profile = result.models.find((m) => m.modelId.startsWith("global."))!;
    expect(profile.availability).toBe("global");
  });

  it("derives availability for regional inference profiles", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel({ modelId: "anthropic.claude-3" }),
      ],
    });
    mockBedrock.on(ListInferenceProfilesCommand).resolves({
      inferenceProfileSummaries: [
        eligibleInferenceProfile({
          inferenceProfileId: "us.anthropic.claude-3",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3",
            },
          ],
        }),
      ],
    });

    const result = await fetchAgentModelsWithPricing(makeServices());
    const profile = result.models.find((m) => m.modelId.startsWith("us."))!;
    expect(profile.availability).toBe("us");
  });

  it("returns empty list when Bedrock returns no eligible models", async () => {
    mockBedrock
      .on(ListFoundationModelsCommand)
      .resolves({ modelSummaries: [] });
    mockBedrock
      .on(ListInferenceProfilesCommand)
      .resolves({ inferenceProfileSummaries: [] });

    const result = await fetchAgentModelsWithPricing(makeServices());
    expect(result.models).toHaveLength(0);
  });

  it("returns foundation models when inference profiles call fails", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [eligibleFoundationModel()],
    });
    mockBedrock
      .on(ListInferenceProfilesCommand)
      .rejects(new Error("throttled"));

    const result = await fetchAgentModelsWithPricing(makeServices());
    expect(result.models).toHaveLength(1);
    expect(result.models[0]!.modelId).toBe("anthropic.claude-sonnet-4-6");
  });

  it("throws when foundation models fail (textCapableIds unavailable — cannot verify profiles)", async () => {
    mockBedrock.on(ListFoundationModelsCommand).rejects(new Error("throttled"));
    mockBedrock.on(ListInferenceProfilesCommand).resolves({
      inferenceProfileSummaries: [eligibleInferenceProfile()],
    });

    await expect(fetchAgentModelsWithPricing(makeServices())).rejects.toThrow(
      "ListFoundationModels failed",
    );
  });

  it("throws when both discovery sources fail", async () => {
    mockBedrock.on(ListFoundationModelsCommand).rejects(new Error("throttled"));
    mockBedrock
      .on(ListInferenceProfilesCommand)
      .rejects(new Error("throttled"));

    // Foundation-model discovery fails before inference profiles are queried.
    await expect(fetchAgentModelsWithPricing(makeServices())).rejects.toThrow(
      "ListFoundationModels failed",
    );
  });

  it("excludes inference profiles backed by foundation models without TEXT input", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel({
          modelId: "stability.sd",
          inputModalities: ["IMAGE"],
        }),
      ],
    });
    mockBedrock.on(ListInferenceProfilesCommand).resolves({
      inferenceProfileSummaries: [
        eligibleInferenceProfile({
          inferenceProfileId: "global.stability.sd",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/stability.sd",
            },
          ],
        }),
      ],
    });

    const result = await fetchAgentModelsWithPricing(makeServices());
    expect(result.models).toHaveLength(0);
  });

  it("includes inference profiles backed by PROVISIONED-only foundation models (TEXT input/output sufficient)", async () => {
    const provisionedOnlyFm = eligibleFoundationModel({
      modelId: "anthropic.claude-sonnet-4-6",
      inferenceTypesSupported: ["PROVISIONED"],
    });
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [provisionedOnlyFm],
    });
    mockBedrock.on(ListInferenceProfilesCommand).resolves({
      inferenceProfileSummaries: [
        eligibleInferenceProfile({
          inferenceProfileId: "global.anthropic.claude-sonnet-4-6",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
            },
          ],
        }),
      ],
    });

    const result = await fetchAgentModelsWithPricing(makeServices());
    expect(result.models).toHaveLength(1);
    expect(result.models[0]!.modelId).toBe(
      "global.anthropic.claude-sonnet-4-6",
    );
  });

  // ─── modelType discriminator ────────────────────────────────────────────────

  it("foundation models carry modelType: foundation-model", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [eligibleFoundationModel()],
    });
    mockBedrock
      .on(ListInferenceProfilesCommand)
      .resolves({ inferenceProfileSummaries: [] });

    const result = await fetchAgentModelsWithPricing(makeServices());
    expect(result.models[0]!.modelType).toBe("foundation-model");
  });

  it("inference profiles carry modelType: inference-profile", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel({
          modelId: "anthropic.claude-sonnet-4-6",
          inferenceTypesSupported: ["PROVISIONED"],
        }),
      ],
    });
    mockBedrock.on(ListInferenceProfilesCommand).resolves({
      inferenceProfileSummaries: [
        eligibleInferenceProfile({
          inferenceProfileId: "us.anthropic.claude-sonnet-4-6",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
            },
          ],
        }),
      ],
    });

    const result = await fetchAgentModelsWithPricing(makeServices());
    const profile = result.models.find(
      (m) => m.modelId === "us.anthropic.claude-sonnet-4-6",
    )!;
    expect(profile.modelType).toBe("inference-profile");
  });

  it("global inference profile uses _Global dimension keys, regional uses plain keys", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel({
          modelId: "anthropic.claude-sonnet-4-6",
          inferenceTypesSupported: ["PROVISIONED"],
        }),
      ],
    });
    mockBedrock.on(ListInferenceProfilesCommand).resolves({
      inferenceProfileSummaries: [
        eligibleInferenceProfile({
          inferenceProfileId: "global.anthropic.claude-sonnet-4-6",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
            },
          ],
        }),
        eligibleInferenceProfile({
          inferenceProfileId: "us.anthropic.claude-sonnet-4-6",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
            },
          ],
        }),
      ],
    });
    // Rate card contains both regional and global dimension keys.
    // The API accepts profile IDs directly — no prefix stripping needed.
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand, {
        modelId: "global.anthropic.claude-sonnet-4-6",
      })
      .resolves({
        offers: [
          {
            offerToken: "tok",
            termDetails: {
              usageBasedPricingTerm: {
                rateCard: [
                  { dimension: "USE1_InputTokenCount_Global", price: "2.7" },
                  { dimension: "USE1_OutputTokenCount_Global", price: "13.5" },
                ],
              },
              legalTerm: {},
              supportTerm: {},
            },
          },
        ],
      });
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand, {
        modelId: "us.anthropic.claude-sonnet-4-6",
      })
      .resolves({
        offers: [
          {
            offerToken: "tok",
            termDetails: {
              usageBasedPricingTerm: {
                rateCard: [
                  { dimension: "USE1_InputTokenCount", price: "3.0" },
                  { dimension: "USE1_OutputTokenCount", price: "15.0" },
                ],
              },
              legalTerm: {},
              supportTerm: {},
            },
          },
        ],
      });

    const result = await fetchAgentModelsWithPricing(makeServices());
    const globalProfile = result.models.find(
      (m) => m.modelId === "global.anthropic.claude-sonnet-4-6",
    )!;
    const usProfile = result.models.find(
      (m) => m.modelId === "us.anthropic.claude-sonnet-4-6",
    )!;

    // Global profile picks _Global-suffixed rates (2.7/1M → 0.0027/1K).
    expect(globalProfile.inputPricePer1KTokens).toBeCloseTo(0.0027);
    expect(globalProfile.outputPricePer1KTokens).toBeCloseTo(0.0135);
    // Regional profile picks plain rates (3.0/1M → 0.003/1K).
    expect(usProfile.inputPricePer1KTokens).toBeCloseTo(0.003);
    expect(usProfile.outputPricePer1KTokens).toBeCloseTo(0.015);
  });

  it("prices a model from agreement offers (all four token types)", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [eligibleFoundationModel()], // anthropic.claude-sonnet-4-6
    });
    mockBedrock
      .on(ListInferenceProfilesCommand)
      .resolves({ inferenceProfileSummaries: [] });
    // Real-world rates ($/Million tokens): Sonnet 4.6 input=$3.00, output=$15.00,
    // cache-read=$0.30, cache-write=$3.75. Per-1K = divide by 1000.
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand, {
        modelId: "anthropic.claude-sonnet-4-6",
      })
      .resolves(
        agreementOffer({
          input: 3.0,
          output: 15.0,
          cacheRead: 0.3,
          cacheWrite: 3.75,
        }),
      );

    const result = await fetchAgentModelsWithPricing(makeServices());
    const model = result.models[0]!;
    expect(model.pricingSource).toBe("agreement-offers");
    // $/M ÷ 1000 = $/1K
    expect(model.inputPricePer1KTokens).toBeCloseTo(0.003);
    expect(model.outputPricePer1KTokens).toBeCloseTo(0.015);
    expect(model.cacheReadPricePer1KTokens).toBeCloseTo(0.0003);
    expect(model.cacheWritePricePer1KTokens).toBeCloseTo(0.00375);
  });

  it("prices an inference profile from agreement offers by its profile ID", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel({
          modelId: "anthropic.claude-sonnet-4-6",
          inferenceTypesSupported: ["PROVISIONED"],
        }),
      ],
    });
    mockBedrock.on(ListInferenceProfilesCommand).resolves({
      inferenceProfileSummaries: [
        eligibleInferenceProfile({
          inferenceProfileId: "global.anthropic.claude-sonnet-4-6",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
            },
          ],
        }),
      ],
    });
    // The API now accepts inference profile IDs directly — no prefix stripping.
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand, {
        modelId: "global.anthropic.claude-sonnet-4-6",
      })
      // Global profiles use _Global-suffixed dimension keys.
      .resolves(agreementOffer({ input: 3.0, output: 15.0 }, true));

    const result = await fetchAgentModelsWithPricing(makeServices());
    const profile = result.models.find(
      (m) => m.modelId === "global.anthropic.claude-sonnet-4-6",
    )!;
    expect(profile.pricingSource).toBe("agreement-offers");
    expect(profile.inputPricePer1KTokens).toBeCloseTo(0.003);
  });

  it("returns a model without price fields when only an input rate is published", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [eligibleFoundationModel()],
    });
    mockBedrock
      .on(ListInferenceProfilesCommand)
      .resolves({ inferenceProfileSummaries: [] });
    // Only input published in $/Million — no output or cache rates.
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand)
      .resolves(agreementOffer({ input: 3.0 }));
    const result = await fetchAgentModelsWithPricing(makeServices());
    expect(result.models).toHaveLength(1);
    const model = result.models[0]!;
    expect(model.modelId).toBe("anthropic.claude-sonnet-4-6");
    expect(model.pricingSource).toBeUndefined();
    expect(model.pricingRefreshedAt).toBeUndefined();
    expect(model.inputPricePer1KTokens).toBeUndefined();
    expect(model.outputPricePer1KTokens).toBeUndefined();
    expect(model.cacheReadPricePer1KTokens).toBeUndefined();
    expect(model.cacheWritePricePer1KTokens).toBeUndefined();
  });
  it("returns a model with no published rate without price fields, and prices the others", async () => {
    // Two models: one priced, one unpriced.
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel({ modelId: "anthropic.claude-3" }),
        eligibleFoundationModel({
          modelId: "anthropic.claude-haiku",
          providerName: "Anthropic",
        }),
      ],
    });
    mockBedrock
      .on(ListInferenceProfilesCommand)
      .resolves({ inferenceProfileSummaries: [] });
    // claude-3 has a published rate ($/Million); haiku has no offers.
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand, {
        modelId: "anthropic.claude-3",
      })
      .resolves(agreementOffer({ input: 3.0, output: 15.0 }));
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand, {
        modelId: "anthropic.claude-haiku",
      })
      .resolves({ offers: [] });
    const result = await fetchAgentModelsWithPricing(makeServices());
    const pricedModel = result.models.find(
      (m) => m.modelId === "anthropic.claude-3",
    )!;
    const unpricedModel = result.models.find(
      (m) => m.modelId === "anthropic.claude-haiku",
    )!;
    expect(pricedModel.pricingSource).toBe("agreement-offers");
    expect(pricedModel.inputPricePer1KTokens).toBeCloseTo(0.003);
    // The unpriced model is still listed, with no price of any kind.
    expect(unpricedModel.pricingSource).toBeUndefined();
    expect(unpricedModel.inputPricePer1KTokens).toBeUndefined();
  });
  it("returns the model without price fields when the agreement offers API throws", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [eligibleFoundationModel()],
    });
    mockBedrock
      .on(ListInferenceProfilesCommand)
      .resolves({ inferenceProfileSummaries: [] });
    // Any error (auth, network, unexpected) — the endpoint stays alive.
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand)
      .rejects(new Error("AccessDenied"));
    const result = await fetchAgentModelsWithPricing(makeServices());
    expect(result.models).toHaveLength(1);
    const model = result.models[0]!;
    expect(model.pricingSource).toBeUndefined();
    expect(model.inputPricePer1KTokens).toBeUndefined();
  });
  // ─── Pricing — pricing:GetProducts ──────────────────────────────────────────

  it("prices a model from GetProducts", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel({
          modelId: "meta.llama3",
          modelName: "Meta Llama 3",
          providerName: "Meta",
        }),
      ],
    });
    mockBedrock
      .on(ListInferenceProfilesCommand)
      .resolves({ inferenceProfileSummaries: [] });
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand)
      .resolves({ offers: [] }); // not called once the Price List prices the model

    // GetProducts returns input and output rows matched by display name (per-1K).
    mockPricing.on(GetProductsCommand).resolves({
      PriceList: [
        priceListEntry("Meta Llama 3", "USE1-Llama3-input-tokens", 0.002),
        priceListEntry("Meta Llama 3", "USE1-Llama3-output-tokens", 0.004),
      ],
    });

    const result = await fetchAgentModelsWithPricing(makeServices());
    const model = result.models[0]!;
    expect(model.pricingSource).toBe("price-list");
    expect(model.inputPricePer1KTokens).toBeCloseTo(0.002);
  });

  it("returns the model without price fields when GetProducts throws", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel({
          modelId: "meta.llama3",
          modelName: "Meta Llama 3",
          providerName: "Meta",
        }),
      ],
    });
    mockBedrock
      .on(ListInferenceProfilesCommand)
      .resolves({ inferenceProfileSummaries: [] });
    mockPricing.on(GetProductsCommand).rejects(new Error("ServiceUnavailable"));
    const result = await fetchAgentModelsWithPricing(makeServices());
    expect(result.models).toHaveLength(1);
    const model = result.models[0]!;
    expect(model.pricingSource).toBeUndefined();
    expect(model.inputPricePer1KTokens).toBeUndefined();
  });

  // ─── All four rate fields always present ────────────────────────────────────

  it("returns all four rates on a priced model, and none on a model with only an input rate", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel(),
        eligibleFoundationModel({
          modelId: "meta.llama3",
          modelName: "Meta Llama 3",
          providerName: "Meta",
        }),
      ],
    });
    mockBedrock
      .on(ListInferenceProfilesCommand)
      .resolves({ inferenceProfileSummaries: [] });
    // Agreement-offer model: full four-rate offer in $/Million tokens.
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand, {
        modelId: "anthropic.claude-sonnet-4-6",
      })
      .resolves(
        agreementOffer({
          input: 3.0,
          output: 15.0,
          cacheRead: 0.3,
          cacheWrite: 3.75,
        }),
      );
    // Price List model: only input rate from GetProducts (already per-1K).
    mockPricing.on(GetProductsCommand).resolves({
      PriceList: [
        priceListEntry("Meta Llama 3", "USE1-Llama3-input-tokens", 0.002),
      ],
    });
    const result = await fetchAgentModelsWithPricing(makeServices());
    const priced = result.models.find(
      (m) => m.modelId === "anthropic.claude-sonnet-4-6",
    )!;
    expect(priced.inputPricePer1KTokens).toBeGreaterThan(0);
    expect(priced.outputPricePer1KTokens).toBeGreaterThan(0);
    expect(priced.cacheReadPricePer1KTokens).toBeGreaterThan(0);
    expect(priced.cacheWritePricePer1KTokens).toBeGreaterThan(0);
    const llama = result.models.find((m) => m.modelId === "meta.llama3")!;
    expect(llama.inputPricePer1KTokens).toBeUndefined();
  });
  it("prices models the Price List misses with agreement offers", async () => {
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand, {
        modelId: "anthropic.claude-sonnet-4-6",
      })
      .resolves(agreementOffer({ input: 3, output: 15, cacheRead: 0.3 }));

    const result = await fetchPricingForModels(
      {
        models: [
          {
            modelId: "anthropic.claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
          },
        ],
      },
      makeServices(),
    );

    expect(result.size).toBe(1);
    expect(result.get("anthropic.claude-sonnet-4-6")).toEqual({
      pricingSource: "agreement-offers",
      input: 0.003,
      output: 0.015,
      cacheRead: 0.0003,
      cacheWrite: 0,
    });
  });

  it("prices models with GetProducts", async () => {
    mockPricing.on(GetProductsCommand).resolves({
      PriceList: [
        priceListEntry("Meta Llama 3", "USE1-Llama3-input-tokens", 0.002),
        priceListEntry("Meta Llama 3", "USE1-Llama3-output-tokens", 0.004),
      ],
    });

    const result = await fetchPricingForModels(
      {
        models: [
          {
            modelId: "meta.llama3",
            displayName: "Meta Llama 3",
          },
        ],
      },
      makeServices(),
    );

    expect(result.get("meta.llama3")).toEqual({
      pricingSource: "price-list",
      input: 0.002,
      output: 0.004,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("omits models with no published rate", async () => {
    const result = await fetchPricingForModels(
      {
        models: [
          { modelId: "anthropic.unpriced", displayName: "Unpriced Claude" },
        ],
      },
      makeServices(),
    );

    expect(result.size).toBe(0);
  });

  it("makes no pricing calls for an empty model list", async () => {
    const result = await fetchPricingForModels({ models: [] }, makeServices());

    expect(result.size).toBe(0);
    expect(mockBedrock.calls()).toHaveLength(0);
    expect(mockPricing.calls()).toHaveLength(0);
  });
});

describe("fetchPublishedModelRates", () => {
  const llama: PricingModel[] = [
    { modelId: "meta.llama3", displayName: "Meta Llama 3" },
  ];
  const llamaRows = [
    priceListEntry("Meta Llama 3", "USE1-Llama3-input-tokens", 0.002),
    priceListEntry("Meta Llama 3", "USE1-Llama3-output-tokens", 0.004),
  ];

  beforeEach(() => {
    mockBedrock.reset();
    mockPricing.reset();
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand)
      .resolves({ offers: [] });
  });

  it("reports a Price List read that reached its last page as complete", async () => {
    mockPricing.on(GetProductsCommand).resolves({ PriceList: llamaRows });

    const result = await fetchPublishedModelRates(
      { models: llama },
      makeServices(),
    );

    expect(result.priceListComplete).toBe(true);
    expect(result.rates.get("meta.llama3")?.input).toBe(0.002);
  });

  it("reports a read that failed part way as incomplete, still pricing from the pages it got", async () => {
    mockPricing
      .on(GetProductsCommand)
      .resolvesOnce({ PriceList: llamaRows, NextToken: "page-2" })
      .rejectsOnce(new Error("ThrottlingException: Rate exceeded"));

    const result = await fetchPublishedModelRates(
      { models: llama },
      makeServices(),
    );

    expect(result.priceListComplete).toBe(false);
    expect(result.rates.get("meta.llama3")).toEqual({
      pricingSource: "price-list",
      input: 0.002,
      output: 0.004,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("resolveModelPricing", () => {
  const live = (rates: Partial<LiveModelRates>): LiveModelRates => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    pricingSource: "price-list",
    ...rates,
  });

  it("fills unpublished cache rates with the input rate", () => {
    expect(
      resolveModelPricing(
        live({
          input: 0.003,
          output: 0.015,
          pricingSource: "agreement-offers",
        }),
      ),
    ).toEqual({
      pricingSource: "agreement-offers",
      inputPricePer1KTokens: 0.003,
      outputPricePer1KTokens: 0.015,
      cacheReadPricePer1KTokens: 0.003,
      cacheWritePricePer1KTokens: 0.003,
    });
  });

  it("keeps published cache rates", () => {
    expect(
      resolveModelPricing(
        live({
          input: 0.003,
          output: 0.015,
          cacheRead: 0.0003,
          cacheWrite: 0.00375,
        }),
      ),
    ).toEqual({
      pricingSource: "price-list",
      inputPricePer1KTokens: 0.003,
      outputPricePer1KTokens: 0.015,
      cacheReadPricePer1KTokens: 0.0003,
      cacheWritePricePer1KTokens: 0.00375,
    });
  });

  it("returns no price when the output rate is unpublished", () => {
    expect(resolveModelPricing(live({ input: 0.003 }))).toBeUndefined();
  });

  it("returns no price when only non-input rates are published", () => {
    expect(
      resolveModelPricing(live({ output: 0.015, cacheRead: 0.0003 })),
    ).toBeUndefined();
  });

  it("returns no price for a model with no rates", () => {
    expect(resolveModelPricing(undefined)).toBeUndefined();
  });
});

describe("Price List name resolution", () => {
  beforeEach(() => {
    mockBedrock.reset();
    mockPricing.reset();
  });

  /** Prices one model against the given Price List rows. */
  async function priceOne(
    modelId: string,
    displayName: string,
    rows: string[],
    base?: Pick<PricingModel, "foundationModelId" | "foundationModelName">,
  ) {
    mockPricing.on(GetProductsCommand).resolves({ PriceList: rows });
    const [pricing] = await priceModels([{ modelId, displayName, ...base }]);
    return pricing!;
  }

  it("uses the model-ID override before the display name", async () => {
    const pricing = await priceOne("amazon.nova-2-lite-v1:0", "Nova 2 Lite", [
      priceListEntry("Nova 2.0 Lite", "USE1-Nova2Lite-input-tokens", 0.0003),
      priceListEntry("Nova 2.0 Lite", "USE1-Nova2Lite-output-tokens", 0.0025),
      priceListEntry("Nova 2 Lite", "USE1-Nova2Lite-input-tokens", 0.009),
      priceListEntry("Nova 2 Lite", "USE1-Nova2Lite-output-tokens", 0.036),
    ]);
    expect(pricing.pricingSource).toBe("price-list");
    expect(pricing.inputPricePer1KTokens).toBeCloseTo(0.0003);
  });

  it("applies a foundation-model override to its inference profiles", async () => {
    const pricing = await priceOne(
      "us.amazon.nova-2-lite-v1:0",
      "US Amazon Nova 2 Lite",
      [
        priceListEntry("Nova 2.0 Lite", "USE1-Nova2Lite-input-tokens", 0.0003),
        priceListEntry("Nova 2.0 Lite", "USE1-Nova2Lite-output-tokens", 0.0025),
      ],
      {
        foundationModelId: "amazon.nova-2-lite-v1:0",
        foundationModelName: "Nova 2 Lite",
      },
    );
    expect(pricing.pricingSource).toBe("price-list");
    expect(pricing.inputPricePer1KTokens).toBeCloseTo(0.0003);
  });

  it("does not fall back to looser matching when the override target is absent", async () => {
    const pricing = await priceOne("amazon.nova-2-lite-v1:0", "Nova 2 Lite", [
      priceListEntry("Nova 2 Lite", "USE1-Nova2Lite-input-tokens", 0.0003),
      priceListEntry("Nova 2 Lite", "USE1-Nova2Lite-output-tokens", 0.0025),
    ]);
    expect(pricing).toBeUndefined();
  });

  it("matches a Price List row keyed by the backing model ID", async () => {
    const pricing = await priceOne(
      "us.xai.grok-4.6",
      "US xAI Grok 4.6",
      [
        priceListEntry("xai.grok-4.6", "USE1-Grok46-input-tokens", 0.002),
        priceListEntry("xai.grok-4.6", "USE1-Grok46-output-tokens", 0.006),
      ],
      { foundationModelId: "xai.grok-4.6", foundationModelName: "Grok 4.6" },
    );
    expect(pricing.pricingSource).toBe("price-list");
    expect(pricing.inputPricePer1KTokens).toBeCloseTo(0.002);
  });

  it("matches on the normalized name, using a profile's backing model name", async () => {
    const minimax = await priceOne("minimax.minimax-m2", "MiniMax M2", [
      priceListEntry("Minimax M2", "USE1-MinimaxM2-input-tokens", 0.0003),
      priceListEntry("Minimax M2", "USE1-MinimaxM2-output-tokens", 0.0012),
    ]);
    expect(minimax.inputPricePer1KTokens).toBeCloseTo(0.0003);

    const novaPro = await priceOne(
      "us.amazon.nova-pro-v1:0",
      "US Nova Pro",
      [
        priceListEntry("NOVA-PRO", "USE1-NovaPro-input-tokens", 0.0008),
        priceListEntry("NOVA-PRO", "USE1-NovaPro-output-tokens", 0.0032),
      ],
      {
        foundationModelId: "amazon.nova-pro-v1:0",
        foundationModelName: "Nova Pro",
      },
    );
    expect(novaPro.inputPricePer1KTokens).toBeCloseTo(0.0008, 6);
  });

  it("never substring-matches a related SKU", async () => {
    // A substring match would take the higher latency-optimized rate.
    const novaPro = await priceOne("amazon.nova-pro-v1:0", "Nova Pro", [
      priceListEntry("Nova Pro", "USE1-NovaPro-input-tokens", 0.0008),
      priceListEntry("Nova Pro", "USE1-NovaPro-output-tokens", 0.0032),
      priceListEntry(
        "Nova Pro Latency Optimized",
        "USE1-NovaProLO-input-tokens",
        0.001,
      ),
      priceListEntry(
        "Nova Pro Latency Optimized",
        "USE1-NovaProLO-output-tokens",
        0.004,
      ),
    ]);
    expect(novaPro.inputPricePer1KTokens).toBeCloseTo(0.0008);

    // Only the related SKU exists, so the model is unpriced.
    const llama = await priceOne("meta.llama-test", "Llama 9 70B", [
      priceListEntry(
        "Llama 9 70B Latency Optimized",
        "USE1-Llama970BLO-input-tokens",
        0.003,
      ),
    ]);
    expect(llama).toBeUndefined();
  });
});

describe("pricing API routing", () => {
  beforeEach(() => {
    mockBedrock.reset();
    mockPricing.reset();
    mockPricing.on(GetProductsCommand).resolves({ PriceList: [] });
  });

  it("falls through to agreement offers for a model the Price List does not price", async () => {
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand)
      .resolves(agreementOffer({ input: 2.5, output: 10 }, true));

    const [pricing] = await priceModels([
      {
        modelId: "global.openai.gpt-5.6-terra",
        displayName: "GPT 5.6 Terra",
      },
    ]);

    expect(pricing!.pricingSource).toBe("agreement-offers");
    expect(mockPricing.commandCalls(GetProductsCommand)).toHaveLength(1);
  });

  it("does not call agreement offers for a model the Price List prices", async () => {
    mockPricing.on(GetProductsCommand).resolves({
      PriceList: [
        priceListEntry("gpt-oss-120b", "USE1-GptOss120b-input-tokens", 0.00015),
        priceListEntry("gpt-oss-120b", "USE1-GptOss120b-output-tokens", 0.0006),
      ],
    });

    const [pricing] = await priceModels([
      {
        modelId: "openai.gpt-oss-120b-1:0",
        displayName: "gpt-oss-120b",
      },
    ]);

    expect(pricing!.pricingSource).toBe("price-list");
    expect(
      mockBedrock.commandCalls(ListFoundationModelAgreementOffersCommand),
    ).toHaveLength(0);
  });

  it("falls through to agreement offers when the Price List fetch fails", async () => {
    mockPricing.on(GetProductsCommand).rejects(new Error("ServiceUnavailable"));
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand)
      .resolves(agreementOffer({ input: 3, output: 15 }));

    const [pricing] = await priceModels([
      {
        modelId: "anthropic.claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
      },
    ]);

    expect(pricing!.pricingSource).toBe("agreement-offers");
  });

  it("treats an unsupported agreement-offer model as unpriced without logging an error", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    mockBedrock.on(ListFoundationModelAgreementOffersCommand).rejects(
      new ValidationException({
        message: "Model does not support agreement offers",
        $metadata: {},
      }),
    );

    const [pricing] = await priceModels([
      { modelId: "meta.llama-test", displayName: "Llama Test" },
    ]);

    expect(pricing).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("Price List usagetype formats and global/regional scope", () => {
  beforeEach(() => {
    mockBedrock.reset();
    mockPricing.reset();
  });

  async function price(
    modelId: string,
    displayName: string,
    rows: string[],
    base?: Pick<PricingModel, "foundationModelId" | "foundationModelName">,
  ) {
    mockPricing.on(GetProductsCommand).resolves({ PriceList: rows });
    const [pricing] = await priceModels([{ modelId, displayName, ...base }]);
    return pricing!;
  }

  const grokRows = [
    priceListEntry(
      "xai.grok-4.6",
      "USE1-xai.grok-4.6-mantle-input-tokens-standard",
      0.0022,
    ),
    priceListEntry(
      "xai.grok-4.6",
      "USE1-xai.grok-4.6-mantle-output-tokens-standard",
      0.0066,
    ),
    priceListEntry(
      "xai.grok-4.6",
      "USE1-xai.grok-4.6-mantle-input-tokens-global-standard",
      0.002,
    ),
    priceListEntry(
      "xai.grok-4.6",
      "USE1-xai.grok-4.6-mantle-output-tokens-global-standard",
      0.006,
    ),
    priceListEntry(
      "xai.grok-4.6",
      "USE1-xai.grok-4.6-mantle-input-tokens-priority",
      0.004,
    ),
  ];

  it("does not send a feature filter to GetProducts", async () => {
    await price("xai.grok-4.6", "Grok 4.6", grokRows);
    const filters =
      mockPricing.commandCalls(GetProductsCommand)[0]!.args[0].input.Filters!;
    expect(filters.map((f) => f.Field)).toEqual(["regionCode"]);
  });

  it("prices new-format standard rows for a regional profile", async () => {
    const pricing = await price(
      "us.xai.grok-4.6",
      "US xAI Grok 4.6",
      grokRows,
      { foundationModelId: "xai.grok-4.6", foundationModelName: "Grok 4.6" },
    );
    expect(pricing.pricingSource).toBe("price-list");
    expect(pricing.inputPricePer1KTokens).toBeCloseTo(0.0022, 6);
    expect(pricing.outputPricePer1KTokens).toBeCloseTo(0.0066, 6);
  });

  it("uses global rows for a global profile", async () => {
    const pricing = await price(
      "global.xai.grok-4.6",
      "Global xAI Grok 4.6",
      grokRows,
      { foundationModelId: "xai.grok-4.6", foundationModelName: "Grok 4.6" },
    );
    expect(pricing.pricingSource).toBe("price-list");
    expect(pricing.inputPricePer1KTokens).toBeCloseTo(0.002, 6);
    expect(pricing.outputPricePer1KTokens).toBeCloseTo(0.006, 6);
  });

  it("recognizes Nova cross-region-global rows as global", async () => {
    const rows = [
      priceListEntry("Nova 2.0 Lite", "USE1-Nova2.0Lite-input-tokens", 0.00033),
      priceListEntry(
        "Nova 2.0 Lite",
        "USE1-Nova2.0Lite-input-tokens-cross-region-global",
        0.0003,
      ),
      priceListEntry(
        "Nova 2.0 Lite",
        "USE1-Nova2.0Lite-output-tokens",
        0.00264,
      ),
      priceListEntry(
        "Nova 2.0 Lite",
        "USE1-Nova2.0Lite-output-tokens-cross-region-global",
        0.0024,
      ),
      priceListEntry(
        "Nova 2.0 Lite",
        "USE1-Nova2.0Lite-cache-read-input-token-count",
        0.0000825,
      ),
      priceListEntry(
        "Nova 2.0 Lite",
        "USE1-Nova2.0Lite-cache-read-input-token-count-cross-region-global",
        0.000075,
      ),
    ];
    const global = await price(
      "global.amazon.nova-2-lite-v1:0",
      "GLOBAL Amazon Nova 2 Lite",
      rows,
      {
        foundationModelId: "amazon.nova-2-lite-v1:0",
        foundationModelName: "Nova 2 Lite",
      },
    );
    expect(global.inputPricePer1KTokens).toBeCloseTo(0.0003, 6);
    expect(global.cacheReadPricePer1KTokens).toBeCloseTo(0.000075, 6);

    const regional = await price(
      "us.amazon.nova-2-lite-v1:0",
      "US Amazon Nova 2 Lite",
      rows,
      {
        foundationModelId: "amazon.nova-2-lite-v1:0",
        foundationModelName: "Nova 2 Lite",
      },
    );
    expect(regional.inputPricePer1KTokens).toBeCloseTo(0.00033, 6);
    expect(regional.cacheReadPricePer1KTokens).toBeCloseTo(0.0000825, 6);
  });

  it("uses regional rows for a global profile when no global rows exist", async () => {
    const pricing = await price(
      "global.zai.glm-4.7",
      "Global GLM 4.7",
      [
        priceListEntry(
          "GLM 4.7",
          "USE1-zai.glm-4.7-mantle-input-tokens-standard",
          0.0006,
        ),
        priceListEntry(
          "GLM 4.7",
          "USE1-zai.glm-4.7-mantle-output-tokens-standard",
          0.0022,
        ),
      ],
      { foundationModelId: "zai.glm-4.7", foundationModelName: "GLM 4.7" },
    );
    expect(pricing.pricingSource).toBe("price-list");
    expect(pricing.inputPricePer1KTokens).toBeCloseTo(0.0006);
  });

  it.each([
    { unit: "1K tokens", inputPrice: 0.001, outputPrice: 0.002 },
    { unit: "1k tokens", inputPrice: 0.001, outputPrice: 0.002 },
    { unit: " 1M tokens ", inputPrice: 1, outputPrice: 2 },
    { unit: "1m tokens", inputPrice: 1, outputPrice: 2 },
  ])("normalizes $unit and converts prices to per-1K", async (testCase) => {
    const pricing = await price("xai.grok-4.3", "Grok 4.3", [
      priceListEntry(
        "xai.grok-4.3",
        "USE1-xai.grok-4.3-mantle-input-tokens-standard",
        testCase.inputPrice,
        testCase.unit,
      ),
      priceListEntry(
        "xai.grok-4.3",
        "USE1-xai.grok-4.3-mantle-output-tokens-standard",
        testCase.outputPrice,
        testCase.unit,
      ),
    ]);
    expect(pricing.inputPricePer1KTokens).toBeCloseTo(0.001);
    expect(pricing.outputPricePer1KTokens).toBeCloseTo(0.002);
  });

  it("skips rows billed in non-token units", async () => {
    const pricing = await price("zai.glm-4.7", "GLM 4.7", [
      priceListEntry(
        "GLM 4.7",
        "USE1-zai.glm-4.7-mantle-input-tokens-standard",
        0.5,
        "Requests",
      ),
    ]);
    expect(pricing).toBeUndefined();
  });

  it("ignores batch, custom-model, and latency-optimized rows", async () => {
    const pricing = await price("zai.glm-4.7", "GLM 4.7", [
      priceListEntry("GLM 4.7", "USE1-zai.glm-4.7-input-tokens-batch", 0.0001),
      priceListEntry(
        "GLM 4.7",
        "USE1-zai.glm-4.7-input-tokens-custom-model",
        0.009,
      ),
      priceListEntry(
        "GLM 4.7",
        "USE1-zai.glm-4.7-input-tokens-latency-optimized",
        0.009,
      ),
    ]);
    expect(pricing).toBeUndefined();
  });
});

describe("agreement offers throttling", () => {
  beforeEach(() => {
    mockBedrock.reset();
    mockPricing.reset();
    mockPricing.on(GetProductsCommand).resolves({ PriceList: [] });
  });

  const model = {
    modelId: "anthropic.claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
  };

  it("retries a throttled call and prices the model", async () => {
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand)
      .rejectsOnce(
        new ThrottlingException({
          message: "You have sent too many requests. Wait before trying again.",
          $metadata: {},
        }),
      )
      .resolves(agreementOffer({ input: 3, output: 15 }));

    const [pricing] = await priceModels([model]);

    expect(pricing!.pricingSource).toBe("agreement-offers");
    expect(
      mockBedrock.commandCalls(ListFoundationModelAgreementOffersCommand),
    ).toHaveLength(2);
  });

  it("gives up after repeated throttling and leaves the model without a price", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockBedrock.on(ListFoundationModelAgreementOffersCommand).rejects(
      new ThrottlingException({
        message: "You have sent too many requests. Wait before trying again.",
        $metadata: {},
      }),
    );

    const [pricing] = await priceModels([model]);

    expect(pricing).toBeUndefined();
    expect(
      mockBedrock.commandCalls(ListFoundationModelAgreementOffersCommand),
    ).toHaveLength(4);
  });

  it("does not retry non-throttling errors", async () => {
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand)
      .rejects(new Error("AccessDenied"));

    const [pricing] = await priceModels([model]);

    expect(pricing).toBeUndefined();
    expect(
      mockBedrock.commandCalls(ListFoundationModelAgreementOffersCommand),
    ).toHaveLength(1);
  });
});

describe("pricing edge cases", () => {
  beforeEach(() => {
    mockBedrock.reset();
    mockPricing.reset();
    mockBedrock
      .on(ListFoundationModelAgreementOffersCommand)
      .resolves({ offers: [] });
    mockPricing.on(GetProductsCommand).resolves({ PriceList: [] });
  });

  it("takes an inference profile's provider and foundation model from its model ARN", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel({
          modelId: "acme.chat-v1",
          modelName: "Acme Chat",
          providerName: "Acme",
        }),
      ],
    });
    mockBedrock.on(ListInferenceProfilesCommand).resolves({
      inferenceProfileSummaries: [
        eligibleInferenceProfile({
          inferenceProfileId: "us.acme.chat-v1",
          inferenceProfileName: "US Acme Chat",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/acme.chat-v1",
            },
          ],
        }),
      ],
    });

    const result = await fetchAgentModelsWithPricing(makeServices());

    const profile = result.models.find((m) => m.modelId === "us.acme.chat-v1");
    expect(profile?.provider).toBe("Acme");
    expect(profile?.foundationModelId).toBe("acme.chat-v1");
    expect(profile?.foundationModelName).toBe("Acme Chat");
  });

  it("prices an inference profile from its backing model's Price List rows", async () => {
    mockBedrock.on(ListFoundationModelsCommand).resolves({
      modelSummaries: [
        eligibleFoundationModel({
          modelId: "acme.chat-v1",
          modelName: "Acme Chat",
          providerName: "Acme",
        }),
      ],
    });
    mockBedrock.on(ListInferenceProfilesCommand).resolves({
      inferenceProfileSummaries: [
        eligibleInferenceProfile({
          inferenceProfileId: "in.acme.chat-v1",
          inferenceProfileName: "IN Acme Chat",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:ap-south-1::foundation-model/acme.chat-v1",
            },
          ],
        }),
      ],
    });
    mockPricing.on(GetProductsCommand).resolves({
      PriceList: [
        priceListEntry("Acme Chat", "USE1-AcmeChat-input-tokens", 0.001),
        priceListEntry("Acme Chat", "USE1-AcmeChat-output-tokens", 0.002),
      ],
    });

    const result = await fetchAgentModelsWithPricing(makeServices());

    const profile = result.models.find((m) => m.modelId === "in.acme.chat-v1");
    expect(profile?.pricingSource).toBe("price-list");
    expect(profile?.inputPricePer1KTokens).toBeCloseTo(0.001, 6);
  });

  it("skips agreement offers for a region with no dimension prefix", async () => {
    const rates = await fetchPricingForModels(
      {
        models: [
          {
            modelId: "anthropic.claude-sonnet-4-6",
            displayName: "Claude Sonnet 4.6",
          },
        ],
      },
      { ...makeServices(), region: "us-gov-west-1" },
    );

    expect(rates.size).toBe(0);
    expect(
      mockBedrock.commandCalls(ListFoundationModelAgreementOffersCommand),
    ).toHaveLength(0);
  });

  it("skips Price List rows that are not valid JSON", async () => {
    mockPricing.on(GetProductsCommand).resolves({
      PriceList: [
        "not-json",
        priceListEntry("Meta Llama 3", "USE1-Llama3-input-tokens", 0.002),
        priceListEntry("Meta Llama 3", "USE1-Llama3-output-tokens", 0.004),
      ],
    });

    const [pricing] = await priceModels([
      { modelId: "meta.llama3", displayName: "Meta Llama 3" },
    ]);

    expect(pricing!.pricingSource).toBe("price-list");
    expect(pricing!.inputPricePer1KTokens).toBeCloseTo(0.002);
  });

  it("does not price a model whose normalized name matches more than one row", async () => {
    mockPricing.on(GetProductsCommand).resolves({
      PriceList: [
        priceListEntry("WIDGET ONE", "USE1-WidgetOne-input-tokens", 0.001),
        priceListEntry("Widget-One", "USE1-WidgetOneB-input-tokens", 0.002),
      ],
    });

    const [pricing] = await priceModels([
      { modelId: "acme.widget-1", displayName: "Widget One" },
    ]);

    expect(pricing).toBeUndefined();
  });

  it("returns partial rates when GetProducts is throttled mid-pagination", async () => {
    mockPricing
      .on(GetProductsCommand)
      .rejects(new Error("ThrottlingException: Rate exceeded"));

    const [pricing] = await priceModels([
      { modelId: "meta.llama3", displayName: "Meta Llama 3" },
    ]);

    expect(pricing).toBeUndefined();
  });
});

describe("resolveEligibleAgentModel", () => {
  const services = () => ({ bedrockClient: new BedrockClient({}), logger });
  const sonnet = eligibleFoundationModel({
    outputModalities: ["TEXT"],
  });
  const profileId = "us.anthropic.claude-sonnet-4-6";
  const profile = (overrides = {}) =>
    ({
      inferenceProfileId: profileId,
      inferenceProfileName: "US Claude Sonnet 4.6",
      status: "ACTIVE",
      type: "SYSTEM_DEFINED",
      models: [
        {
          modelArn:
            "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
        },
      ],
      ...overrides,
    }) as any;
  const notFound = () =>
    new ResourceNotFoundException({ message: "not found", $metadata: {} });

  beforeEach(() => {
    mockBedrock.reset();
    mockBedrock
      .on(GetFoundationModelCommand)
      .rejects(notFound())
      .on(GetFoundationModelCommand, { modelIdentifier: sonnet.modelId })
      .resolves({ modelDetails: sonnet });
    mockBedrock
      .on(GetInferenceProfileCommand)
      .rejects(notFound())
      .on(GetInferenceProfileCommand, { inferenceProfileIdentifier: profileId })
      .resolves(profile());
  });

  it("returns an eligible foundation model", async () => {
    const model = await resolveEligibleAgentModel(
      { modelId: sonnet.modelId, modelType: "foundation-model" },
      services(),
    );
    expect(model).toMatchObject({
      modelId: sonnet.modelId,
      displayName: "Claude Sonnet 4.6",
      provider: "Anthropic",
      modelType: "foundation-model",
    });
  });

  it.each([
    ["has no text output", { outputModalities: ["IMAGE"] }],
    ["has no text input", { inputModalities: ["IMAGE"] }],
    ["does not stream", { responseStreamingSupported: false }],
    ["is not active", { modelLifecycle: { status: "LEGACY" } }],
    [
      "has no on-demand inference",
      { inferenceTypesSupported: ["PROVISIONED"] },
    ],
  ])("rejects a foundation model that %s", async (_reason, overrides) => {
    mockBedrock
      .on(GetFoundationModelCommand, { modelIdentifier: sonnet.modelId })
      .resolves({ modelDetails: { ...sonnet, ...overrides } });
    await expect(
      resolveEligibleAgentModel(
        { modelId: sonnet.modelId, modelType: "foundation-model" },
        services(),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a model Bedrock describes under a different ID", async () => {
    const arn = `arn:aws:bedrock:us-east-1::foundation-model/${sonnet.modelId}`;
    mockBedrock
      .on(GetFoundationModelCommand, { modelIdentifier: arn })
      .resolves({ modelDetails: sonnet });
    await expect(
      resolveEligibleAgentModel(
        { modelId: arn, modelType: "foundation-model" },
        services(),
      ),
    ).resolves.toBeUndefined();
  });

  it("treats a malformed identifier as not found", async () => {
    mockBedrock
      .on(GetFoundationModelCommand)
      .rejects(new ValidationException({ message: "bad id", $metadata: {} }));
    await expect(
      resolveEligibleAgentModel(
        { modelId: "not a model", modelType: "foundation-model" },
        services(),
      ),
    ).resolves.toBeUndefined();
  });

  it("throws Bedrock errors other than not found", async () => {
    mockBedrock
      .on(GetFoundationModelCommand)
      .rejects(new ThrottlingException({ message: "slow", $metadata: {} }));
    await expect(
      resolveEligibleAgentModel(
        { modelId: sonnet.modelId, modelType: "foundation-model" },
        services(),
      ),
    ).rejects.toBeInstanceOf(ThrottlingException);
  });

  it("returns an eligible inference profile described by its routed model", async () => {
    const model = await resolveEligibleAgentModel(
      { modelId: profileId, modelType: "inference-profile" },
      services(),
    );
    expect(model).toMatchObject({
      modelId: profileId,
      displayName: "US Claude Sonnet 4.6",
      provider: "Anthropic",
      availability: "us",
      modelType: "inference-profile",
      foundationModelId: sonnet.modelId,
      foundationModelName: "Claude Sonnet 4.6",
    });
  });

  it.each([
    ["is not active", { status: "INACTIVE" }],
    ["is application-defined", { type: "APPLICATION" }],
    ["routes to no model", { models: [] }],
    [
      "routes to a model Bedrock does not describe locally",
      {
        models: [
          {
            modelArn:
              "arn:aws:bedrock:us-east-1::foundation-model/unknown.model-v1",
          },
        ],
      },
    ],
  ])("rejects an inference profile that %s", async (_reason, overrides) => {
    mockBedrock
      .on(GetInferenceProfileCommand, { inferenceProfileIdentifier: profileId })
      .resolves(profile(overrides));
    await expect(
      resolveEligibleAgentModel(
        { modelId: profileId, modelType: "inference-profile" },
        services(),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects an inference profile whose routed model has no text output", async () => {
    mockBedrock
      .on(GetFoundationModelCommand, { modelIdentifier: sonnet.modelId })
      .resolves({ modelDetails: { ...sonnet, outputModalities: ["IMAGE"] } });
    await expect(
      resolveEligibleAgentModel(
        { modelId: profileId, modelType: "inference-profile" },
        services(),
      ),
    ).resolves.toBeUndefined();
  });

  it("does not look a foundation model up as an inference profile", async () => {
    await expect(
      resolveEligibleAgentModel(
        { modelId: sonnet.modelId, modelType: "inference-profile" },
        services(),
      ),
    ).resolves.toBeUndefined();
    expect(mockBedrock.commandCalls(GetFoundationModelCommand)).toHaveLength(0);
  });
});
