// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePermissionSets } from "@amzn/innovation-sandbox-frontend/domains/permissionSets/hooks";

const mockResetQueries = vi.fn();
const mockUseInfiniteQuery = vi.fn((options: unknown) => {
  void options;
  return { data: undefined };
});

vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: (options: unknown) => mockUseInfiniteQuery(options),
  useQueryClient: () => ({ resetQueries: mockResetQueries }),
}));

describe("usePermissionSets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not override application refetch defaults with undefined options", () => {
    renderHook(() => usePermissionSets());

    const options = mockUseInfiniteQuery.mock.calls[0]![0];
    expect(options).toHaveProperty("queryKey", ["permissionSets", "", 20]);
    expect(options).not.toHaveProperty("enabled");
    expect(options).not.toHaveProperty("refetchOnMount");
    expect(options).not.toHaveProperty("refetchOnReconnect");
    expect(options).not.toHaveProperty("refetchOnWindowFocus");
  });

  it("passes explicit lazy-loading options through to React Query", () => {
    renderHook(() =>
      usePermissionSets(" developer ", {
        enabled: false,
        pageSize: 50,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
      }),
    );

    expect(mockUseInfiniteQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["permissionSets", "developer", 50],
        enabled: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
      }),
    );
  });
});
