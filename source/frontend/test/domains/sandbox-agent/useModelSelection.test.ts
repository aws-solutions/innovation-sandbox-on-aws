// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useModelSelection } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/useModelSelection";

const A = "global.anthropic.claude-sonnet-4-6";
const B = "us.anthropic.claude-sonnet-4-6";
const C = "us.amazon.nova-pro-v1";

describe("useModelSelection", () => {
  it("defaults to the provided default when it is allowed", () => {
    const { result } = renderHook(() => useModelSelection([A, B], B));
    expect(result.current.selectedModelId).toBe(B);
  });

  it("defaults to the first allowed model when no default is given", () => {
    const { result } = renderHook(() => useModelSelection([A, B]));
    expect(result.current.selectedModelId).toBe(A);
  });

  it("defaults to the first allowed model when the default is not allowed", () => {
    const { result } = renderHook(() => useModelSelection([A, B], C));
    expect(result.current.selectedModelId).toBe(A);
  });

  it("is undefined when the allowed list is empty", () => {
    const { result } = renderHook(() => useModelSelection([]));
    expect(result.current.selectedModelId).toBeUndefined();
  });

  it("keeps a user selection across re-renders", () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useModelSelection(ids, A),
      { initialProps: { ids: [A, B, C] } },
    );
    act(() => result.current.setSelectedModelId(C));
    expect(result.current.selectedModelId).toBe(C);

    rerender({ ids: [A, B, C] });
    expect(result.current.selectedModelId).toBe(C);
  });

  it("falls back to the default when the selected model becomes unavailable", () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useModelSelection(ids, A),
      { initialProps: { ids: [A, B, C] } },
    );
    act(() => result.current.setSelectedModelId(C));
    expect(result.current.selectedModelId).toBe(C);

    // C is removed from the allowed set mid-session.
    rerender({ ids: [A, B] });
    expect(result.current.selectedModelId).toBe(A);
  });

  it("falls back to the first model when the selection drops out and no default is allowed", () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useModelSelection(ids),
      { initialProps: { ids: [A, B, C] } },
    );
    act(() => result.current.setSelectedModelId(C));
    rerender({ ids: [B, C] });
    expect(result.current.selectedModelId).toBe(C); // still allowed
    rerender({ ids: [B] });
    expect(result.current.selectedModelId).toBe(B); // C gone -> first
  });
});
