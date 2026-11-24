// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useLatest } from "@amzn/innovation-sandbox-frontend/hooks/useLatest";

describe("useLatest", () => {
  it("keeps a stable ref containing the latest value", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useLatest(value),
      { initialProps: { value: "first" } },
    );
    const initialRef = result.current;

    rerender({ value: "second" });

    expect(result.current).toBe(initialRef);
    expect(result.current.current).toBe("second");
  });
});
