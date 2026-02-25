// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { EditBlueprintDeploymentConfig } from "@amzn/innovation-sandbox-frontend/domains/blueprints/pages/EditBlueprintDeploymentConfig";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createBlueprintWithStackSets } from "@amzn/innovation-sandbox-frontend/mocks/factories/blueprintFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();
const mockBlueprint = createBlueprintWithStackSets();
const mockBlueprintId = mockBlueprint.blueprint.blueprintId;

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ blueprintId: mockBlueprintId }),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

describe("EditBlueprintDeploymentConfig", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.clearAllMocks();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditBlueprintDeploymentConfig />
      </Router>,
    );

  test("renders loading state initially", () => {
    renderComponent();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  test("renders form with existing blueprint deployment configuration", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/Deployment strategy/i)).toBeInTheDocument();
    });
  });

  test("navigates back on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Deployment strategy/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockNavigate).toHaveBeenCalledWith(`/blueprints/${mockBlueprintId}`);
  });

  test("submits form successfully and shows success toast", async () => {
    const submitSpy = vi.fn();
    server.use(
      http.put(
        `${config.ApiUrl}/blueprints/${mockBlueprintId}`,
        async ({ request }) => {
          const data = await request.json();
          submitSpy(data);
          return HttpResponse.json({
            status: "success",
            data: mockBlueprint,
          });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Deployment strategy/i)).toBeInTheDocument();
    });

    const defaultRadio = screen.getByRole("radio", {
      name: /Default/i,
    });
    await user.click(defaultRadio);

    await waitFor(() => {
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      expect(saveButton).not.toBeDisabled();
    });

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Deployment configuration updated successfully",
      );
      expect(mockNavigate).toHaveBeenCalledWith(
        `/blueprints/${mockBlueprintId}`,
      );
    });
  });

  test("displays error toast on submission failure", async () => {
    server.use(
      http.put(`${config.ApiUrl}/blueprints/${mockBlueprintId}`, () => {
        return HttpResponse.json(
          { status: "error", message: "Update failed" },
          { status: 500 },
        );
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Deployment strategy/i)).toBeInTheDocument();
    });

    const defaultRadio = screen.getByRole("radio", {
      name: /Default/i,
    });
    await user.click(defaultRadio);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update deployment configuration"),
        "Update Failed",
      );
    });
  });

  test("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/Deployment strategy/i)).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    expect(saveButton).toBeDisabled();
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
        screen.getByText(/There was a problem loading this blueprint/i),
      ).toBeInTheDocument();
    });
  });
});
