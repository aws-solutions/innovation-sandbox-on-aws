// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  hasCompleteConfigurationResponseMetadata,
  resolveBedrockTokenMonitoringEnabled,
} from "../types/configuration.js";

// Both adapters use this guard; accepting partial metadata could silently drop
// lastEditTime, which is the optimistic-concurrency token.
describe("hasCompleteConfigurationResponseMetadata", () => {
  it.each([
    undefined,
    {},
    { createdTime: "2026-09-09T00:00:00.000Z" },
    { lastEditTime: "2026-09-09T00:00:00.000Z" },
  ])("rejects absent or partial metadata", (meta) => {
    expect(hasCompleteConfigurationResponseMetadata(meta)).toBe(false);
  });

  it("accepts metadata only when both timestamps are present", () => {
    expect(
      hasCompleteConfigurationResponseMetadata({
        createdTime: "2026-09-09T00:00:00.000Z",
        lastEditTime: "2026-09-09T00:01:00.000Z",
      }),
    ).toBe(true);
  });
});

describe("resolveBedrockTokenMonitoringEnabled", () => {
  it.each([
    { configured: false, sandboxSpacesEnabled: false, expected: false },
    { configured: true, sandboxSpacesEnabled: false, expected: true },
    { configured: false, sandboxSpacesEnabled: true, expected: true },
    { configured: true, sandboxSpacesEnabled: true, expected: true },
  ])(
    "returns $expected for configured=$configured and sandboxSpacesEnabled=$sandboxSpacesEnabled",
    ({ configured, sandboxSpacesEnabled, expected }) => {
      expect(
        resolveBedrockTokenMonitoringEnabled({
          configured,
          sandboxSpacesEnabled,
        }),
      ).toBe(expected);
    },
  );
});
