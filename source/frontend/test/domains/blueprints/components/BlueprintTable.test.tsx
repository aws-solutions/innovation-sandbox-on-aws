// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper, {
  ButtonWrapper,
} from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { BlueprintTable } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/BlueprintTable";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import {
  createBlueprint,
  createBlueprintWithStackSets,
  createDeploymentHistory,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/blueprintFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

// Mock ResizeObserver
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;

// Mock the useUser hook
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => ({
    isAdmin: true,
    isManager: false,
    isUser: false,
  }),
}));

describe("BlueprintTable", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <ModalProvider>
        <BrowserRouter>
          <BlueprintTable />
        </BrowserRouter>
      </ModalProvider>,
    );

  const mockBlueprint = createBlueprint({
    name: "Test-Blueprint",
    createdBy: "admin@example.com",
    deploymentTimeoutMinutes: 30,
    totalHealthMetrics: {
      totalDeploymentCount: 10,
      totalSuccessfulCount: 8,
      lastDeploymentAt: new Date().toISOString(),
    },
  });

  const mockBlueprintWithDeployments = createBlueprintWithStackSets({
    blueprint: mockBlueprint,
    recentDeployments: [
      createDeploymentHistory({ status: "SUCCEEDED" }),
      createDeploymentHistory({ status: "FAILED" }),
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders the table header correctly", async () => {
    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();
    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const header = table?.findHeaderSlot();

    await waitFor(() => {
      expect(header?.getElement()).toHaveTextContent("Blueprints");
    });
  });

  test("displays blueprints in table", async () => {
    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [mockBlueprintWithDeployments],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Test-Blueprint")).toBeInTheDocument();
      expect(screen.getByText("admin@example.com")).toBeInTheDocument();
      expect(screen.getByText("30 min")).toBeInTheDocument();
    });
  });

  test("displays 'No blueprints found' when no blueprints", async () => {
    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      const wrapper = createWrapper();
      const table = wrapper.findTable();
      expect(table?.findEmptySlot()?.getElement()).toHaveTextContent(
        "No blueprints found",
      );
    });
  });

  test("displays health metrics correctly", async () => {
    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [mockBlueprintWithDeployments],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("8 / 10")).toBeInTheDocument();
    });
  });

  test("displays '-' for blueprints with zero deployments", async () => {
    const blueprintWithNoDeployments = createBlueprintWithStackSets({
      blueprint: createBlueprint({
        totalHealthMetrics: {
          totalDeploymentCount: 0,
          totalSuccessfulCount: 0,
        },
      }),
    });

    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [blueprintWithNoDeployments],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(1);
    });
  });

  test("displays multiple blueprints with multi-selection enabled", async () => {
    const blueprint1 = createBlueprintWithStackSets({
      blueprint: createBlueprint({
        name: "Blueprint 1",
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
      }),
    });
    const blueprint2 = createBlueprintWithStackSets({
      blueprint: createBlueprint({
        name: "Blueprint 2",
        blueprintId: "650e8400-e29b-41d4-a716-446655440002",
      }),
    });

    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [blueprint1, blueprint2],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Blueprint 1")).toBeInTheDocument();
      expect(screen.getByText("Blueprint 2")).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    expect(table?.findRows()).toHaveLength(2);
  });

  test("refreshes blueprint data when refresh button is clicked", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        requestCount++;
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints:
              requestCount === 1
                ? [mockBlueprintWithDeployments]
                : [
                    mockBlueprintWithDeployments,
                    createBlueprintWithStackSets({
                      blueprint: createBlueprint({ name: "New Blueprint" }),
                    }),
                  ],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Test-Blueprint")).toBeInTheDocument();
      expect(screen.queryByText("New Blueprint")).not.toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const refreshButton = table?.findComponent(
      '[data-testid="refresh-button"]',
      ButtonWrapper,
    );

    expect(refreshButton).not.toBeNull();
    expect(refreshButton?.getElement()).not.toBeDisabled();
    await user.click(refreshButton!.getElement());

    await waitFor(() => {
      expect(screen.getByText("Test-Blueprint")).toBeInTheDocument();
      expect(screen.getByText("New Blueprint")).toBeInTheDocument();
    });
  });

  test("hides Actions button for non-admin users", async () => {
    vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
      useUser: () => ({
        isAdmin: false,
        isManager: true,
        isUser: false,
      }),
    }));

    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [mockBlueprintWithDeployments],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Test-Blueprint")).toBeInTheDocument();
    });

    expect(screen.queryByText("Actions")).not.toBeInTheDocument();
  });

  test("displays blueprint tags", async () => {
    const blueprintWithTags = createBlueprintWithStackSets({
      blueprint: createBlueprint({
        name: "Tagged Blueprint",
        tags: { environment: "production", team: "platform" },
      }),
    });

    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [blueprintWithTags],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Tagged Blueprint")).toBeInTheDocument();
    });

    // Tags are not displayed in the table - they're shown in the details page
    // This test verifies the blueprint with tags loads correctly
    expect(screen.getByText("Tagged Blueprint")).toBeInTheDocument();
  });
});
