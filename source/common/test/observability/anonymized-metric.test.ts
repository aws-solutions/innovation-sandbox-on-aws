// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { sendAnonymizedMetricToAWS } from "@amzn/innovation-sandbox-commons/observability/anonymized-metric.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { createMockOf } from "test/mocking/mock-utils.js";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock fetch globally
global.fetch = vi.fn();

describe("sendAnonymizedMetricToAWS", () => {
  const mockIsbContext = {
    env: {
      METRICS_URL: "https://example.com/metrics",
      METRICS_UUID: "test-uuid-123",
      HUB_ACCOUNT_ID: "123456789012",
      SOLUTION_ID: "SO0284",
      SOLUTION_VERSION: "1.0.0",
    },
    logger: createMockOf(Logger),
    tracer: new Tracer(),
  };

  const mockMetricData = {
    event_name: "test_event",
    context_version: 1,
    context: { key: "value" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  test("sends metric with correct payload", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    await sendAnonymizedMetricToAWS(mockMetricData, mockIsbContext);

    expect(fetch).toHaveBeenCalledWith("https://example.com/metrics", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        timestamp: "2024-01-01T00:00:00.000Z",
        uuid: "test-uuid-123",
        hub_account_id: "123456789012",
        solution: "SO0284",
        version: "1.0.0",
        event_name: "test_event",
        context_version: 1,
        context: { key: "value" },
      }),
    });
  });

  test("logs metric data", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    await sendAnonymizedMetricToAWS(mockMetricData, mockIsbContext);

    expect(mockIsbContext.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "reporting anonymized metric to https://example.com/metrics:",
      ),
    );
  });

  test("returns fetch response", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const result = await sendAnonymizedMetricToAWS(
      mockMetricData,
      mockIsbContext,
    );

    expect(result).toBe(mockResponse);
  });

  test("handles fetch errors", async () => {
    const fetchError = new Error("Network error");
    vi.mocked(fetch).mockRejectedValue(fetchError);

    await expect(
      sendAnonymizedMetricToAWS(mockMetricData, mockIsbContext),
    ).rejects.toThrow("Network error");
  });
});
