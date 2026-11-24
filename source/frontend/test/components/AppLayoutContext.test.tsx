// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.unmock(
  "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext",
);

import {
  AppLayoutProvider,
  useAppLayoutContext,
} from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";

it("keeps tools callbacks stable when the provider rerenders", () => {
  const onToolsChange = vi.fn();
  const onToolsContentChange = vi.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AppLayoutProvider
      toolsOpen={false}
      onToolsChange={onToolsChange}
      onToolsContentChange={onToolsContentChange}
    >
      {children}
    </AppLayoutProvider>
  );

  const { result, rerender } = renderHook(() => useAppLayoutContext(), {
    wrapper,
  });
  const initialSetTools = result.current.setTools;
  const initialSetToolsOpen = result.current.setToolsOpen;

  rerender();

  expect(result.current.setTools).toBe(initialSetTools);
  expect(result.current.setToolsOpen).toBe(initialSetToolsOpen);

  act(() => {
    result.current.setTools("Assignments help");
    result.current.setToolsOpen(true);
  });
  expect(onToolsContentChange).toHaveBeenCalledWith("Assignments help");
  expect(onToolsChange).toHaveBeenCalledWith(true);
});
