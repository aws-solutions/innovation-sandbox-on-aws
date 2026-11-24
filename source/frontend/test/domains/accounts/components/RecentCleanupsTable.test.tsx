// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { RecentCleanupsTable } from "@amzn/innovation-sandbox-frontend/domains/accounts/components/RecentCleanupsTable";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import {
  createMockCleanupReport,
  createMockFailedReport,
  createMockInProgressReport,
} from "@amzn/innovation-sandbox-frontend-test/domains/accounts/factories/cleanupReportFactory";

class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserver;

describe("RecentCleanupsTable", () => {
  const defaultProps = {
    reports: [createMockCleanupReport()],
    selectedReport: createMockCleanupReport(),
    onSelect: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    onLoadMore: vi.fn(),
    onRefresh: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("renders table with correct columns", () => {
    renderWithQueryClient(<RecentCleanupsTable {...defaultProps} />);

    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Cleanup reason")).toBeInTheDocument();
    expect(screen.getByText("Started")).toBeInTheDocument();
    expect(screen.getByText("Duration")).toBeInTheDocument();
  });

  test("shows correct status indicator for COMPLETED report", () => {
    const reports = [createMockCleanupReport({ status: "COMPLETED" })];

    renderWithQueryClient(
      <RecentCleanupsTable
        {...defaultProps}
        reports={reports}
        selectedReport={reports[0]}
      />,
    );

    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  test("shows correct status indicator for FAILED report", () => {
    const reports = [createMockFailedReport()];

    renderWithQueryClient(
      <RecentCleanupsTable
        {...defaultProps}
        reports={reports}
        selectedReport={reports[0]}
      />,
    );

    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  test("shows correct status indicator for IN_PROGRESS report", () => {
    const reports = [createMockInProgressReport()];

    renderWithQueryClient(
      <RecentCleanupsTable
        {...defaultProps}
        reports={reports}
        selectedReport={reports[0]}
      />,
    );

    expect(screen.getByText("Nuke Phase 1")).toBeInTheDocument();
  });

  test("calls onSelect when a row is selected", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const reports = [
      createMockCleanupReport({
        startedAt: "2024-06-15T10:00:00.000Z",
      }),
      createMockCleanupReport({
        startedAt: "2024-06-15T09:00:00.000Z",
        reasonForCleanup: "ACCOUNT_REGISTRATION",
      }),
    ];

    vi.useRealTimers();
    renderWithQueryClient(
      <RecentCleanupsTable
        {...defaultProps}
        reports={reports}
        selectedReport={reports[0]}
        onSelect={onSelect}
      />,
    );

    const radioButtons = screen.getAllByRole("radio");
    await user.click(radioButtons[1]);

    expect(onSelect).toHaveBeenCalledWith(reports[1]);
  });

  test("shows refresh button and calls onRefresh when clicked", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    vi.useRealTimers();
    renderWithQueryClient(
      <RecentCleanupsTable {...defaultProps} onRefresh={onRefresh} />,
    );

    const refreshButton = screen.getByRole("button", {
      name: "Refresh cleanup reports",
    });
    expect(refreshButton).toBeInTheDocument();

    await user.click(refreshButton);

    expect(onRefresh).toHaveBeenCalledOnce();
  });

  test("shows 'Load more' button when hasNextPage is true", () => {
    renderWithQueryClient(
      <RecentCleanupsTable {...defaultProps} hasNextPage={true} />,
    );

    expect(
      screen.getByRole("button", { name: /Load more/i }),
    ).toBeInTheDocument();
  });

  test("hides 'Load more' button when hasNextPage is false", () => {
    renderWithQueryClient(
      <RecentCleanupsTable {...defaultProps} hasNextPage={false} />,
    );

    expect(
      screen.queryByRole("button", { name: /Load more/i }),
    ).not.toBeInTheDocument();
  });

  test("shows empty state when no reports", () => {
    renderWithQueryClient(
      <RecentCleanupsTable
        {...defaultProps}
        reports={[]}
        selectedReport={createMockCleanupReport()}
      />,
    );

    expect(
      screen.getByText("No cleanup history available"),
    ).toBeInTheDocument();
  });

  test("shows each report's start as a relative time", () => {
    const reports = [
      createMockCleanupReport({ startedAt: "2024-06-15T07:00:00.000Z" }),
    ];

    renderWithQueryClient(
      <RecentCleanupsTable
        {...defaultProps}
        reports={reports}
        selectedReport={reports[0]}
      />,
    );

    expect(screen.getByText("5 hours ago")).toBeInTheDocument();
  });
});
