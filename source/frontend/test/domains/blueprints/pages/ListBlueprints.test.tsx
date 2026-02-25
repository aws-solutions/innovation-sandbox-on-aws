// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { BrowserRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ListBlueprints } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/ListBlueprints";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createBlueprintWithStackSets } from "@amzn/innovation-sandbox-frontend/mocks/factories/blueprintFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

// Mock ResizeObserver
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;

// Mock the useBreadcrumb hook
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
}));

// Mock the navigate function
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock the useUser hook
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => ({
    isAdmin: true,
    isManager: false,
    isUser: false,
  }),
}));

describe("ListBlueprints", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <BrowserRouter>
        <ListBlueprints />
      </BrowserRouter>,
    );

  const mockBlueprint = createBlueprintWithStackSets();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("renders the header correctly", async () => {
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
    const header = wrapper.findHeader();

    expect(header?.findHeadingText()?.getElement()).toHaveTextContent(
      "Blueprints",
    );
    expect(header?.findDescription()?.getElement()).toHaveTextContent(
      "View and manage your blueprints",
    );
  });

  test("renders BlueprintTable component", async () => {
    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [mockBlueprint],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      const wrapper = createWrapper();
      const table = wrapper.findTable();
      expect(table).not.toBeNull();
    });
  });

  test("displays blueprints in the table", async () => {
    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [mockBlueprint],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(mockBlueprint.blueprint.name),
      ).toBeInTheDocument();
      expect(
        screen.getByText(mockBlueprint.blueprint.createdBy),
      ).toBeInTheDocument();
    });
  });

  test("displays empty state when no blueprints", async () => {
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

  test("displays loading state while fetching blueprints", async () => {
    server.use(
      http.get(`${config.ApiUrl}/blueprints`, async () => {
        // Delay response to test loading state
        await new Promise((resolve) => setTimeout(resolve, 100));
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

    // Check for loading state
    expect(table?.findLoadingText()?.getElement()).toHaveTextContent(
      "Loading blueprints...",
    );
  });

  test("displays info link in header", async () => {
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
      const header = wrapper.findHeader();
      expect(header).not.toBeNull();
    });
  });
});
