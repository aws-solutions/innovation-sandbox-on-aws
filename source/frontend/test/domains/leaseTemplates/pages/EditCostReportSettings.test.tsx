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
import { EditCostReportSettings } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditCostReportSettings";
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

describe("EditCostReportSettings", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.clearAllMocks();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditCostReportSettings />
      </Router>,
    );

  test("renders form with existing cost report settings", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(/Edit Cost Report Settings/i),
      ).toBeInTheDocument();
    });
  });

  test("navigates back on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByText(/Edit Cost Report Settings/i),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
  });

  test("submits form successfully", async () => {
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
      expect(
        screen.getByText(/Edit Cost Report Settings/i),
      ).toBeInTheDocument();
    });

    // Enable cost report group
    const enableToggle = screen.getByRole("checkbox");
    await user.click(enableToggle);

    await waitFor(() => {
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      expect(saveButton).not.toBeDisabled();
    });

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Cost report settings updated successfully.",
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
      expect(
        screen.getByText(/Edit Cost Report Settings/i),
      ).toBeInTheDocument();
    });

    const enableToggle = screen.getByRole("checkbox");
    await user.click(enableToggle);

    await waitFor(() => {
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      expect(saveButton).not.toBeDisabled();
    });

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update cost report settings"),
        "Update Failed",
      );
    });
  });

  test("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(/Edit Cost Report Settings/i),
      ).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    expect(saveButton).toBeDisabled();
  });
});
