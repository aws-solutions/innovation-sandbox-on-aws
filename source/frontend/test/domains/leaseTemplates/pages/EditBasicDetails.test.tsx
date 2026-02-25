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
import { EditBasicDetails } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditBasicDetails";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { mockBasicLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();
const mockUuid = mockBasicLeaseTemplate.uuid;

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

describe("EditBasicDetails", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.clearAllMocks();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditBasicDetails />
      </Router>,
    );

  test("renders loading state initially", () => {
    renderComponent();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  test("renders form with existing lease template data", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toHaveValue(
        mockBasicLeaseTemplate.name,
      );
    });

    // Description field may be optional, check if it exists
    const descriptionField = screen.queryByLabelText("Description");
    if (descriptionField && mockBasicLeaseTemplate.description) {
      expect(descriptionField).toHaveValue(mockBasicLeaseTemplate.description);
    }
  });

  test("navigates back on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
  });

  test("submits form successfully and shows success toast", async () => {
    const submitSpy = vi.fn();
    server.use(
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
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });

    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Updated Template Name");

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Basic details updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
    });
  });

  test("displays error toast on submission failure", async () => {
    server.use(
      http.put(`${config.ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json(
          { status: "error", message: "Update failed" },
          { status: 500 },
        );
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });

    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Updated Name");

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update basic details"),
        "Update Failed",
      );
    });
  });

  test("disables save button when form is invalid", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });

    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);

    await waitFor(() => {
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      expect(saveButton).toBeDisabled();
    });
  });

  test("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    expect(saveButton).toBeDisabled();
  });

  test("displays error panel when lease template fails to load", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json(
          { status: "error", message: "Not found" },
          { status: 404 },
        );
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(/There was a problem loading this lease template/i),
      ).toBeInTheDocument();
    });
  });
});
