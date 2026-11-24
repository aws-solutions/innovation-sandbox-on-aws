// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { describe, expect, it } from "vitest";

describe("IsbClients.sns", () => {
  it("configures maxAttempts and customUserAgent, and caches the client across calls", async () => {
    const client = IsbClients.sns({ USER_AGENT_EXTRA: "isb-test-agent" });

    expect(client.config.customUserAgent).toEqual([["isb-test-agent"]]);
    await expect(client.config.maxAttempts()).resolves.toBe(3);

    // cachedSNSClient is module-level state (`??=`); this file is the only
    // consumer of IsbClients.sns in its Vitest module instance, so the second
    // call exercises the cache-hit branch rather than re-constructing a client.
    const secondCall = IsbClients.sns({ USER_AGENT_EXTRA: "isb-test-agent" });
    expect(secondCall).toBe(client);
  });
});
