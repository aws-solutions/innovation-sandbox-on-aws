// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getNotificationErrorNames } from "@amzn/innovation-sandbox-commons/observability/notification-metrics.js";

function namedError(name: string): Error {
  const error = new Error();
  error.name = name;
  return error;
}

describe("getNotificationErrorNames", () => {
  it("deduplicates and truncates error names", () => {
    const longName = "X".repeat(300);

    expect(
      getNotificationErrorNames([
        namedError(longName),
        namedError(longName),
        namedError("MessageRejected"),
      ]),
    ).toEqual(["X".repeat(256), "MessageRejected"]);
  });

  it("keeps at most ten names and ignores non-Error values", () => {
    const errors = [
      "raw error",
      ...Array.from({ length: 12 }, (_, i) => namedError(`Error${i}`)),
    ];

    expect(getNotificationErrorNames(errors)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Error${i}`),
    );
  });
});
