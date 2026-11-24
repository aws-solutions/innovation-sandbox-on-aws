// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
export {
  computeProjection,
  computeSpendRates,
  computeTimeToExhaustion,
  projectionRatePerHour,
} from "./spend-rate.service.js";
export type {
  ComputeProjectionInput,
  ComputeTimeToExhaustionInput,
  CostObservationPoint,
  CostProjection,
  RateSource,
  SpendRates,
} from "./spend-rate.types.js";
