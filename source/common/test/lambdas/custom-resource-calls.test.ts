// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { describe, expect, it, vi } from "vitest";

import { customResourceCalls } from "@amzn/innovation-sandbox-commons/lambda/custom-resource-calls.js";

function awsError(name: string, message: string) {
  return Object.assign(new Error(message), { name });
}

function setup(hints?: Record<string, string>) {
  const logger = new Logger();
  const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
  return { errorSpy, ...customResourceCalls(logger, hints) };
}

describe("customResourceCalls", () => {
  it("returns the call's result", async () => {
    const { calling, errorSpy } = setup();

    await expect(calling("ListThings", async () => "things")).resolves.toBe(
      "things",
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("names the failed call and appends the hint for the error name", async () => {
    const { calling } = setup({ AccessDenied: "; deploy from the owner" });

    // an Error matches on the whole message
    await expect(
      calling("ListThings", async () => {
        throw awsError("AccessDenied", "denied");
      }),
    ).rejects.toThrow(
      new Error(
        "ListThings failed: AccessDenied: denied; deploy from the owner",
      ),
    );
  });

  it("appends nothing for an error name without a hint", async () => {
    const { calling } = setup({ AccessDenied: "; deploy from the owner" });

    await expect(
      calling("ListThings", async () => {
        throw awsError("ThrottlingException", "slow down");
      }),
    ).rejects.toThrow(
      new Error("ListThings failed: ThrottlingException: slow down"),
    );
  });

  it("keeps the original error as the cause and logs the failure once", () => {
    const { wrap, errorSpy } = setup();
    const original = awsError("ValidationError", "bad input");

    const wrapped = wrap("DescribeThing", original);

    expect(wrapped.cause).toBe(original);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith({
      message: "DescribeThing failed",
      error: original,
    });
  });
});
