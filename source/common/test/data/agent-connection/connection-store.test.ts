// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { ConnectionRecordSchema } from "@amzn/innovation-sandbox-commons/data/agent-connection/connection-store.js";
import { sanitizeActorId } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";

const validRecord = {
  connectionId: "abc123",
  actorId: "alice-at-example-d-com",
  role: "User",
  email: "alice@example.com",
  userId: "11111111-1111-4111-8111-111111111111",
  protocolVersion: 1,
  ttl: 9999999999,
};

describe("ConnectionRecordSchema", () => {
  it.each([
    "first_last@example.com",
    "team-name+long-service-pipeline-test-user@example.com",
  ])("accepts the actorId generated for %s", (email) => {
    const actorId = sanitizeActorId(email);

    expect(
      ConnectionRecordSchema.safeParse({ ...validRecord, actorId }).success,
    ).toBe(true);
  });
});
