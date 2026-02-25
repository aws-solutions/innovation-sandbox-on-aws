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
import { BlueprintListResponse } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import { EditBlueprintSelection } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditBlueprintSelection";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { mockBlueprint } from "@amzn/innovation-sandbox-frontend/mocks/handlers/blueprintHandlers";
import { mockAdvancedLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import { ApiResponse } from "@amzn/innovation-sandbox-frontend/types";

const mockNavigate = vi.fn();
const mockUuid = mockAdvancedLeaseTemplate.uuid;

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ uuid: mockUuid }),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

describe("EditBlueprintSelection", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.clearAllMocks();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditBlueprintSelection />
      </Router>,
    );

  test("renders loading state initially", () => {
    renderComponent();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  test("renders form with blueprint toggle", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/Edit Blueprint Selection/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/Enable Blueprint Selection/i)).toBeInTheDocument();
  });

  test("navigates back on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Edit Blueprint Selection/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
  });

  test("submits form successfully with blueprint selection", async () => {
    const submitSpy = vi.fn();

    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            blueprintId: undefined,
          },
        });
      }),
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [mockBlueprint],
          },
        } as ApiResponse<BlueprintListResponse>);
      }),
      http.put(
        `${config.ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          const data = await request.json();
          submitSpy(data);
          return HttpResponse.json({ status: "success", data });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Edit Blueprint Selection/i)).toBeInTheDocument();
    });

    // Toggle ON to show blueprint selector (template has no blueprint, so toggle starts OFF)
    const toggle = screen.getByRole("checkbox", {
      name: /Blueprint selection disabled/i,
    });
    await user.click(toggle);

    await waitFor(() => {
      expect(
        screen.getByText(mockBlueprint.blueprint.name),
      ).toBeInTheDocument();
    });

    const blueprintCard = screen.getByText(mockBlueprint.blueprint.name);
    await user.click(blueprintCard);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Blueprint selection updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
    });
  });

  test("submits form successfully when removing blueprint via toggle", async () => {
    const submitSpy = vi.fn();

    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            blueprintId: mockBlueprint.blueprint.blueprintId,
          },
        });
      }),
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: { blueprints: [mockBlueprint] },
        } as ApiResponse<BlueprintListResponse>);
      }),
      http.put(
        `${config.ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          const data = await request.json();
          submitSpy(data);
          return HttpResponse.json({ status: "success", data });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Edit Blueprint Selection/i)).toBeInTheDocument();
    });

    // Toggle starts ON because template has a blueprint — toggle OFF to remove
    const toggle = await screen.findByRole("checkbox", {
      name: /Blueprint selection enabled/i,
    });
    await user.click(toggle);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Blueprint selection updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
    });
  });

  test("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/Edit Blueprint Selection/i)).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    expect(saveButton).toBeDisabled();
  });

  test("hides blueprint selector when toggle is off", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            blueprintId: undefined,
          },
        });
      }),
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: { blueprints: [mockBlueprint] },
        } as ApiResponse<BlueprintListResponse>);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/Edit Blueprint Selection/i)).toBeInTheDocument();
    });

    // Toggle is OFF (no blueprint on template), so blueprint cards should not be visible
    expect(
      screen.queryByText(mockBlueprint.blueprint.name),
    ).not.toBeInTheDocument();
  });

  test("shows blueprint selector when toggle is on", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            blueprintId: mockBlueprint.blueprint.blueprintId,
          },
        });
      }),
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: { blueprints: [mockBlueprint] },
        } as ApiResponse<BlueprintListResponse>);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/Edit Blueprint Selection/i)).toBeInTheDocument();
    });

    // Toggle is ON (template has blueprint), so blueprint cards should be visible
    await waitFor(() => {
      expect(
        screen.getByText(mockBlueprint.blueprint.name),
      ).toBeInTheDocument();
    });
  });

  test("displays error toast on submission failure", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            blueprintId: undefined,
          },
        });
      }),
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: { blueprints: [mockBlueprint] },
        } as ApiResponse<BlueprintListResponse>);
      }),
      // Mock PUT to fail
      http.put(`${config.ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json(
          {
            status: "Update Failed",
            message: "Internal server error",
          },
          { status: 500 },
        );
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Edit Blueprint Selection/i)).toBeInTheDocument();
    });

    // Toggle ON to show blueprint selector
    const toggle = screen.getByRole("checkbox", {
      name: /Blueprint selection disabled/i,
    });
    await user.click(toggle);

    await waitFor(() => {
      expect(
        screen.getByText(mockBlueprint.blueprint.name),
      ).toBeInTheDocument();
    });

    const blueprintCard = screen.getByText(mockBlueprint.blueprint.name);
    await user.click(blueprintCard);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update blueprint selection"),
        "Update Failed",
      );
    });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test("disables toggle and shows message when no blueprints exist", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            blueprintId: undefined,
          },
        });
      }),
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: { blueprints: [] },
        } as ApiResponse<BlueprintListResponse>);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/Edit Blueprint Selection/i)).toBeInTheDocument();
    });

    await waitFor(() => {
      const toggle = screen.getByRole("checkbox");
      expect(toggle).toBeDisabled();
    });

    expect(
      screen.getByText(/No blueprints are available/i),
    ).toBeInTheDocument();
  });
});
