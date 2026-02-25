// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";
import { describe, expect, test } from "vitest";

import { calculateDurationInMinutes } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

describe("calculateDurationInMinutes", () => {
  test("should calculate duration between start time and now", () => {
    const startTime = DateTime.utc().minus({ minutes: 45 }).toISO();
    const duration = calculateDurationInMinutes(startTime);

    expect(duration).toBeGreaterThanOrEqual(44);
    expect(duration).toBeLessThanOrEqual(46);
  });

  test("should calculate duration between start time and specific end time", () => {
    const startTime = "2025-01-01T10:00:00.000Z";
    const endTime = DateTime.fromISO("2025-01-01T10:30:00.000Z");

    const duration = calculateDurationInMinutes(startTime, endTime);

    expect(duration).toBe(30);
  });

  test("should round duration to nearest minute", () => {
    const startTime = "2025-01-01T10:00:00.000Z";
    const endTime = DateTime.fromISO("2025-01-01T10:15:29.999Z");

    const duration = calculateDurationInMinutes(startTime, endTime);

    expect(duration).toBe(15);
  });

  test("should handle fractional minutes correctly", () => {
    const startTime = "2025-01-01T10:00:00.000Z";
    const endTime = DateTime.fromISO("2025-01-01T10:15:30.000Z");

    const duration = calculateDurationInMinutes(startTime, endTime);

    expect(duration).toBe(16);
  });

  test("should handle zero duration", () => {
    const startTime = "2025-01-01T10:00:00.000Z";
    const endTime = DateTime.fromISO("2025-01-01T10:00:00.000Z");

    const duration = calculateDurationInMinutes(startTime, endTime);

    expect(duration).toBe(0);
  });

  test("should handle duration less than 1 minute", () => {
    const startTime = "2025-01-01T10:00:00.000Z";
    const endTime = DateTime.fromISO("2025-01-01T10:00:30.000Z");

    const duration = calculateDurationInMinutes(startTime, endTime);

    expect(duration).toBe(1);
  });
});
