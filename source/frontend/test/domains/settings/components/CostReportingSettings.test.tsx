// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { describe, expect, test } from "vitest";

import {
  testErrorState,
  testLoadingState,
  testRefetchOnError,
} from "@amzn/innovation-sandbox-frontend-test/utils/settingsTestUtils";
import { CostReportingSettings } from "@amzn/innovation-sandbox-frontend/domains/settings/components/CostReportingSettings";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { mockConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

describe("CostReportingSettings", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <CostReportingSettings />
      </Router>,
    );

  test("renders cost reporting settings correctly", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("Require Cost Report Groups"),
      ).toBeInTheDocument();
      expect(screen.getByText("Cost Report Groups")).toBeInTheDocument();
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

  test("displays when cost report group is required", async () => {
    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: { ...mockConfiguration, requireCostReportGroup: true },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("Cost report group is required"),
      ).toBeInTheDocument();
    });
  });

  test("displays when cost report group is not required", async () => {
    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: { ...mockConfiguration, requireCostReportGroup: false },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("Cost report group is not required"),
      ).toBeInTheDocument();
    });
  });

  test("displays cost report groups when available", async () => {
    const testGroups = ["group1", "group2", "group3"];
    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: { ...mockConfiguration, costReportGroups: testGroups },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      testGroups.forEach((group) => {
        expect(screen.getByText(group)).toBeInTheDocument();
      });
    });
  });

  test("displays warning when no cost report groups are set", async () => {
    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: { ...mockConfiguration, costReportGroups: [] },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Not set")).toBeInTheDocument();
    });
  });
});
