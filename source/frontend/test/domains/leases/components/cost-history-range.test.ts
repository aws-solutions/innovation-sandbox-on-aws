// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime, Settings } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isValidRange,
  lastIncludedInstant,
  toCostHistoryRange,
  WHOLE_LEASE,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/cost-history-range";

const defaultZone = Settings.defaultZone;
beforeAll(() => {
  // The picker reports wall-clock times, read here as UTC whatever zone runs this.
  Settings.defaultZone = "utc";
});
afterAll(() => {
  Settings.defaultZone = defaultZone;
});

describe("toCostHistoryRange", () => {
  it("asks for no bounds for the whole lease or a cleared picker", () => {
    expect(toCostHistoryRange(WHOLE_LEASE)).toBeUndefined();
    expect(toCostHistoryRange(null)).toBeUndefined();
  });

  it("reaches a relative range back from the instant it is given", () => {
    const now = DateTime.fromISO("2026-08-11T11:30:00.000Z");

    expect(
      toCostHistoryRange(
        { key: "last-24-hours", type: "relative", amount: 24, unit: "hour" },
        now,
      ),
    ).toStrictEqual({ afterTimestamp: "2026-08-10T11:30:00.000Z" });
  });

  it("bounds an absolute range at both ends, as instants, ending just past its end", () => {
    expect(
      toCostHistoryRange({
        type: "absolute",
        startDate: "2026-08-11T09:00:00",
        endDate: "2026-08-11T10:30:00",
      }),
    ).toEqual({
      afterTimestamp: "2026-08-11T09:00:00.000Z",
      beforeTimestamp: "2026-08-11T10:30:00.001Z",
    });
  });

  it("asks for the instant an absolute range starts and ends at", () => {
    expect(
      toCostHistoryRange({
        type: "absolute",
        startDate: "2026-08-11T09:00:00",
        endDate: "2026-08-11T09:00:00",
      }),
    ).toEqual({
      afterTimestamp: "2026-08-11T09:00:00.000Z",
      beforeTimestamp: "2026-08-11T09:00:00.001Z",
    });
  });
});

describe("lastIncludedInstant", () => {
  it("is the millisecond before a range's end", () => {
    expect(
      lastIncludedInstant({
        afterTimestamp: "2026-08-11T09:00:00.000Z",
        beforeTimestamp: "2026-08-11T10:30:00.001Z",
      }),
    ).toBe("2026-08-11T10:30:00.000Z");
  });

  it("is undefined for a range running to now, or no range", () => {
    expect(
      lastIncludedInstant({ afterTimestamp: "2026-08-11T09:00:00.000Z" }),
    ).toBeUndefined();
    expect(lastIncludedInstant(undefined)).toBeUndefined();
  });
});

describe("isValidRange", () => {
  it("asks for a range where none is picked", () => {
    expect(isValidRange(null)).toEqual({
      valid: false,
      errorMessage: "Select a range.",
    });
  });

  it("takes a relative range of one or more units", () => {
    expect(
      isValidRange({ key: "x", type: "relative", amount: 1, unit: "hour" }),
    ).toEqual({ valid: true });
  });

  it.each([0, -1, Number.NaN])(
    "refuses a relative range of %s units",
    (amount) => {
      expect(
        isValidRange({ key: "x", type: "relative", amount, unit: "hour" }),
      ).toEqual({
        valid: false,
        errorMessage: "Enter a duration of one or more.",
      });
    },
  );

  it("asks for both ends of an absolute range", () => {
    expect(
      isValidRange({
        type: "absolute",
        startDate: "2026-08-11T09:00:00",
        endDate: "",
      }),
    ).toEqual({
      valid: false,
      errorMessage: "Set both a start and an end date and time.",
    });
  });

  it("refuses an absolute range that starts after it ends", () => {
    expect(
      isValidRange({
        type: "absolute",
        startDate: "2026-08-11T10:00:00",
        endDate: "2026-08-11T09:00:00",
      }),
    ).toEqual({
      valid: false,
      errorMessage: "The start must not be after the end.",
    });
  });

  it("takes an absolute range that starts and ends at the same instant", () => {
    expect(
      isValidRange({
        type: "absolute",
        startDate: "2026-08-11T09:00:00",
        endDate: "2026-08-11T09:00:00",
      }),
    ).toEqual({ valid: true });
  });
});
