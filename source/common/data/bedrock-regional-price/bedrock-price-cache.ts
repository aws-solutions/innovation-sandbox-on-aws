// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const PricingSourceSchema = z.enum(["agreement-offers", "price-list"]);

export type PricingSource = z.infer<typeof PricingSourceSchema>;

/**
 * One model's prices in one region, per 1,000 tokens, with the time they were
 * fetched.
 */
export const BedrockRegionalPriceSchema = z
  .object({
    modelId: z.string().min(1).max(300),
    region: z.string().min(1),
    // All four token types required — summing fewer is the most common source of billing gaps.
    inputPricePer1KTokens: z.number().nonnegative(),
    outputPricePer1KTokens: z.number().nonnegative(),
    cacheReadPricePer1KTokens: z.number().nonnegative(),
    cacheWritePricePer1KTokens: z.number().nonnegative(),
    pricingSource: PricingSourceSchema,
    pricingRefreshedAt: z.iso.datetime(),
  })
  .strict();

export type BedrockRegionalPrice = z.infer<typeof BedrockRegionalPriceSchema>;

/** The model and region a regional price is stored under. */
export type BedrockRegionalPriceKey = Pick<
  BedrockRegionalPrice,
  "modelId" | "region"
>;

/**
 * A cache of Bedrock prices by model and region. The token poll reads it on
 * each run and refills it from the pricing APIs.
 */
export interface BedrockPriceCache {
  /**
   * The cached prices for the given keys, which must be distinct. A key with
   * no price is left out, and an item that fails validation is dropped and
   * logged.
   */
  getPrices(keys: BedrockRegionalPriceKey[]): Promise<BedrockRegionalPrice[]>;
  /**
   * Saves prices, replacing any stored for the same model and region. Each
   * price expires 30 days after its last save.
   */
  putPrices(prices: BedrockRegionalPrice[]): Promise<void>;
}
