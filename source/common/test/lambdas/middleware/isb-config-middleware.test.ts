// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigSchemaVersion } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { DynamoConfigStore } from "@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { ConfigSchemas } from "@amzn/innovation-sandbox-shared/types/configuration.js";

const testEnv = {
  CONFIG_TABLE_NAME: "test-config-table",
  USER_AGENT_EXTRA: "test-agent",
};

function makeRequest(context: Record<string, unknown> = {}) {
  return { context: { env: testEnv, ...context } };
}

function meta() {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    createdTime: now,
    lastEditTime: now,
    schemaVersion: ConfigSchemaVersion,
  };
}

function mockGetAllSections(
  sections: Awaited<ReturnType<DynamoConfigStore["getAllSections"]>>,
) {
  vi.spyOn(IsbServices, "configStore").mockReturnValue(
    new DynamoConfigStore({ client: {} as any, tableName: "test" }),
  );
  return vi
    .spyOn(DynamoConfigStore.prototype, "getAllSections")
    .mockResolvedValue(sections);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isbConfigMiddleware", () => {
  it("assembles all sections from code defaults when DynamoDB is empty", async () => {
    mockGetAllSections({});

    const request = makeRequest();
    await isbConfigMiddleware().before!(request as any);

    const { globalConfig } = request.context as unknown as ContextWithConfig;
    expect(globalConfig.maintenance).toEqual(
      ConfigSchemas.maintenance.parse({}),
    );
    expect(globalConfig.leases).toEqual(ConfigSchemas.leases.parse({}));
    expect(globalConfig.costReporting).toEqual(
      ConfigSchemas.costReporting.parse({}),
    );
    expect(globalConfig.notification).toEqual(
      ConfigSchemas.notification.parse({}),
    );
  });

  it("uses stored sections when present, stripping lastSavedBy/meta before parsing", async () => {
    mockGetAllSections({
      maintenance: {
        ...ConfigSchemas.maintenance.parse({ enabled: false }),
        lastSavedBy: "admin@example.com",
        meta: meta(),
      },
    });

    const request = makeRequest();
    await isbConfigMiddleware().before!(request as any);

    const { globalConfig } = request.context as unknown as ContextWithConfig;
    // The stored value wins, and the audit envelope is stripped (a `.strict()`
    // schema would otherwise throw on `lastSavedBy`/`meta`).
    expect(globalConfig.maintenance).toEqual({ enabled: false });
    // Sections absent from DynamoDB still fall back to code defaults.
    expect(globalConfig.leases).toEqual(ConfigSchemas.leases.parse({}));
  });
});
