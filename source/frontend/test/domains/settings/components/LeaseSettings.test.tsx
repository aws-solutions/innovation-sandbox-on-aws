// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor, within } from "@testing-library/react";
import { BrowserRouter as Router } from "react-router-dom";
import { describe, expect, test } from "vitest";

import {
  testErrorState,
  testLoadingState,
  testRefetchOnError,
} from "@amzn/innovation-sandbox-frontend-test/utils/settingsTestUtils";
import { LeaseSettings } from "@amzn/innovation-sandbox-frontend/domains/settings/components/LeaseSettings";
import { mockConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

describe("LeaseSettings", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <LeaseSettings />
      </Router>,
    );

  test("renders lease settings correctly", async () => {
    renderComponent();

    await waitFor(() => {
      // Budget settings
      const maxBudgetLabel = screen.getByText("Max Budget");
      expect(maxBudgetLabel).toBeInTheDocument();
      expect(
        within(maxBudgetLabel.closest("dt")!.closest("div")!).getByText(
          `$${mockConfiguration.leases.maxBudget} USD`,
        ),
      ).toBeInTheDocument();

      const requireMaxBudgetLabel = screen.getByText("Require Max Budget");
      expect(requireMaxBudgetLabel).toBeInTheDocument();
      expect(
        within(requireMaxBudgetLabel.closest("dt")!.closest("div")!).getByText(
          mockConfiguration.leases.requireMaxBudget.toString(),
        ),
      ).toBeInTheDocument();

      // Lease duration settings
      const leaseDurationLabel = screen.getByText("Max Lease Duration");
      expect(leaseDurationLabel).toBeInTheDocument();
      expect(
        within(leaseDurationLabel.closest("dt")!.closest("div")!).getByText(
          `${mockConfiguration.leases.maxDurationHours} hours`,
        ),
      ).toBeInTheDocument();

      const requireMaxDurationLabel = screen.getByText(
        "Require Max Lease Duration",
      );
      expect(requireMaxDurationLabel).toBeInTheDocument();
      expect(
        within(
          requireMaxDurationLabel.closest("dt")!.closest("div")!,
        ).getByText(mockConfiguration.leases.requireMaxDuration.toString()),
      ).toBeInTheDocument();

      // User limits
      const maxLeasesPerUserLabel = screen.getByText("Max leases per user");
      expect(maxLeasesPerUserLabel).toBeInTheDocument();
      expect(
        within(maxLeasesPerUserLabel.closest("dt")!.closest("div")!).getByText(
          `${mockConfiguration.leases.maxLeasesPerUser}`,
        ),
      ).toBeInTheDocument();
    });
  });

  test("handles loading state", async () => {
    await testLoadingState(renderComponent);
  });

  test("handles error state", async () => {
    await testErrorState(renderComponent);
  });

  test("refetches data on error retry", async () => {
    await testRefetchOnError(renderComponent);
  });
});
