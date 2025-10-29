// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { showErrorToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { AddLeaseTemplate } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/AddLeaseTemplate";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

describe("AddLeaseTemplate", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <AddLeaseTemplate />
      </Router>,
    );

  const fillFormAndNavigate = async (
    user: ReturnType<typeof userEvent.setup>,
  ) => {
    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });

    // Fill out the Basic Details
    await user.type(screen.getByLabelText("Name"), "Test Template");

    await user.type(screen.getByLabelText("Description"), "Test Description");

    const visibilitySelect = screen.getByLabelText("Visibility");
    await user.click(visibilitySelect);
    await waitFor(() => {
      const publicOptions = screen.getAllByText(
        "Public - Visible to all users",
      );
      return user.click(publicOptions[0]);
    });

    await user.click(screen.getByLabelText("Approval required"));

    // Navigate to Budget step
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Filling out Budget details
    await user.type(screen.getByLabelText("Maximum Budget Amount"), "1000");

    // Navigate to Duration step
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Filling out Duration details
    await user.type(
      screen.getByLabelText("Maximum Lease Duration (in hours)"),
      "24",
    );

    // Navigate to Cost Report step
    await user.click(screen.getByRole("button", { name: /next/i }));
  };

  test("renders the form with correct initial values", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Add a New Lease Template")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Give your users a new way to access a temporary AWS account.",
        ),
      ).toBeInTheDocument();
    });

    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
    expect(screen.getByLabelText("Visibility")).toHaveTextContent(/Private/);
    expect(screen.getByLabelText("Approval required")).toBeChecked();
  });

  test("navigates back to lease templates page on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    const cancelButton = (
      await screen.findAllByRole("button", { name: /cancel/i })
    )[0];
    await user.click(cancelButton);

    expect(mockNavigate).toHaveBeenCalledWith("/lease_templates");
  });

  test("submits form and navigates on successful submission", async () => {
    const submitSpy = vi.fn();
    server.use(
      http.post(`${config.ApiUrl}/leaseTemplates`, async ({ request }) => {
        const data = await request.json();
        submitSpy(data);
        return HttpResponse.json({ status: "success", data });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user);

    const submitButton = await screen.findByRole("button", { name: /submit/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/lease_templates");
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Test Description",
          leaseDurationInHours: 24,
          maxSpend: 1000,
          name: "Test Template",
          requiresApproval: false,
          visibility: "PUBLIC",
        }),
      );
    });
  });

  test("displays error message on submission failure", async () => {
    server.use(
      http.post(`${config.ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json(
          { status: "error", message: "Failed to create template" },
          { status: 500 },
        );
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user);

    const submitButton = await screen.findByRole("button", { name: /submit/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        "HTTP error 500",
        "Whoops, something went wrong!",
      );
    });
  });
});
