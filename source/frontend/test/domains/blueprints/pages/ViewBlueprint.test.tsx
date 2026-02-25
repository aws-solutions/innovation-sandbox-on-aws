// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ViewBlueprint } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/ViewBlueprint";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { mockBlueprint } from "@amzn/innovation-sandbox-frontend/mocks/handlers/blueprintHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();
const mockBlueprintId = mockBlueprint.blueprint.blueprintId;

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ blueprintId: mockBlueprintId }),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
}));

const mockUseUser = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

const waitForBlueprintToLoad = async () => {
  await waitFor(() => {
    expect(
      screen.getAllByText(mockBlueprint.blueprint.name)[0],
    ).toBeInTheDocument();
  });
};

describe("ViewBlueprint", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.clearAllMocks();
    mockUseUser.mockReturnValue({
      isAdmin: true,
      isManager: false,
      isUser: false,
    });
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <ViewBlueprint />
      </Router>,
    );

  test("renders loading state initially", () => {
    renderComponent();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  test("renders blueprint details after loading", async () => {
    renderComponent();
    await waitForBlueprintToLoad();

    expect(screen.getByText(/Basic Details/i)).toBeInTheDocument();
    expect(screen.getByText(/Tags/i)).toBeInTheDocument();
    expect(screen.getByText(/Deployment Configuration/i)).toBeInTheDocument();
    expect(screen.getByText(/Health metrics/i)).toBeInTheDocument();

    expect(
      screen.getByText(mockBlueprint.blueprint.blueprintId),
    ).toBeInTheDocument();
    expect(
      screen.getByText(mockBlueprint.blueprint.createdBy),
    ).toBeInTheDocument();

    expect(screen.getByText(/StackSet details/i)).toBeInTheDocument();
    expect(screen.getByText(/Recent deployments/i)).toBeInTheDocument();
  });

  test("displays error panel when blueprint fails to load", async () => {
    server.use(
      http.get(`${config.ApiUrl}/blueprints/${mockBlueprintId}`, () => {
        return HttpResponse.json(
          { status: "error", message: "Not found" },
          { status: 404 },
        );
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(/We couldn't load the blueprint details/i),
      ).toBeInTheDocument();
    });
  });

  describe("role-based Edit button visibility", () => {
    test("admin user sees Edit buttons and can navigate to edit pages", async () => {
      mockUseUser.mockReturnValue({
        isAdmin: true,
        isManager: false,
        isUser: false,
      });

      renderComponent();
      await waitForBlueprintToLoad();
      const user = userEvent.setup();

      const editButtons = screen.getAllByRole("button", { name: /edit/i });
      expect(editButtons.length).toEqual(3);

      // Click first Edit button (Basic Details)
      await user.click(editButtons[0]);
      expect(mockNavigate).toHaveBeenCalledWith(
        `/blueprints/${mockBlueprintId}/edit/basic`,
      );

      mockNavigate.mockClear();

      // Click last Edit button (Deployment Configuration)
      const lastEditButton = editButtons[editButtons.length - 1];
      await user.click(lastEditButton);
      expect(mockNavigate).toHaveBeenCalledWith(
        `/blueprints/${mockBlueprintId}/edit/deployment`,
      );
    });

    test("manager user does not see any Edit buttons", async () => {
      mockUseUser.mockReturnValue({
        isAdmin: false,
        isManager: true,
        isUser: false,
      });

      renderComponent();
      await waitForBlueprintToLoad();

      const editButtons = screen.queryAllByRole("button", { name: /edit/i });
      expect(editButtons).toHaveLength(0);
    });
  });
});
