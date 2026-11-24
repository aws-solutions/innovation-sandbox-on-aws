// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  formatAbsoluteTime,
  formatCurrency,
  formatRate,
  formatRelativeTime,
  stripControlCharacters,
} from "@amzn/innovation-sandbox-shared/utils/format-utils.js";

describe("formatCurrency", () => {
  it.each([
    [70.5, "USD 70.50"],
    [52, "USD 52.00"],
    [0, "USD 0.00"],
    [0.005, "USD 0.01"],
    [-3.5, "-USD 3.50"],
    [-0.004, "USD 0.00"],
  ])("formats %s as %s", (amount, expected) => {
    expect(formatCurrency(amount)).toBe(expected);
  });
});

describe("formatRate", () => {
  it("formats an hourly rate", () => {
    expect(formatRate(1.5, "hour")).toBe("USD 1.50/hour");
  });

  it("formats a daily rate", () => {
    expect(formatRate(20, "day")).toBe("USD 20.00/day");
  });
});

describe("formatRelativeTime", () => {
  const base = DateTime.fromISO("2026-01-01T12:00:00.000Z", { zone: "utc" });

  it("renders a timestamp three hours old as '3 hours ago'", () => {
    expect(formatRelativeTime("2026-01-01T09:00:00.000Z", base)).toBe(
      "3 hours ago",
    );
  });

  it("renders a timestamp two days old as '2 days ago'", () => {
    expect(formatRelativeTime("2025-12-30T12:00:00.000Z", base)).toBe(
      "2 days ago",
    );
  });

  it("falls back to the raw string for an unparseable timestamp", () => {
    expect(formatRelativeTime("not-a-timestamp", base)).toBe("not-a-timestamp");
  });
});

describe("formatAbsoluteTime", () => {
  it("renders the full local date and time for an ISO timestamp", () => {
    const timestamp = "2026-01-01T09:00:00.000Z";
    expect(formatAbsoluteTime(timestamp)).toBe(
      DateTime.fromISO(timestamp).toLocaleString(DateTime.DATETIME_HUGE),
    );
  });

  it.each(["not-a-timestamp", "", "2026-01-01 09:00:00", "1767258000000"])(
    "falls back to the raw string for %j instead of 'Invalid DateTime'",
    (value) => {
      expect(formatAbsoluteTime(value)).toBe(value);
    },
  );
});

describe("escapeHtml", () => {
  it("escapes every character that can break out of an HTML text node or attribute", () => {
    expect(escapeHtml(`<b>"Tom" & 'Jerry'</b>`)).toBe(
      "&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;",
    );
  });

  it("leaves a plain service name unchanged", () => {
    expect(escapeHtml("Amazon Elastic Compute Cloud - Compute")).toBe(
      "Amazon Elastic Compute Cloud - Compute",
    );
  });
});

describe("stripControlCharacters", () => {
  it("removes line breaks and other control characters but keeps markup inert as text", () => {
    expect(stripControlCharacters("Amazon\nBedrock\u0007 <b>")).toBe(
      "AmazonBedrock <b>",
    );
  });
});
