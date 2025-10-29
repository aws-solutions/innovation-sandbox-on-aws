// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter as Router } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import { showErrorToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { BasicDetailsForm } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/BasicDetailsForm";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { mockBasicLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import { http, HttpResponse } from "msw";

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
}));

describe("BasicDetailsForm", () => {
  const mockLeaseTemplate: LeaseTemplate = {
    ...mockBasicLeaseTemplate,
    visibility: "PUBLIC",
  };
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <BasicDetailsForm leaseTemplate={mockLeaseTemplate} />
      </Router>,
    );

  test("renders the form with correct initial values", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toHaveValue(mockLeaseTemplate.name);
      expect(screen.getByLabelText("Description")).toHaveValue(
        mockLeaseTemplate.description,
      );
      expect(screen.getByLabelText("Approval required")).not.toBeChecked();
      expect(screen.getByLabelText("Visibility")).toHaveTextContent(/Public/);
    });
  });

  test("submits form with updated values", async () => {
    const submitSpy = vi.fn();
    server.use(
      http.put(
        `${config.ApiUrl}/leaseTemplates/:${mockLeaseTemplate.uuid}`,
        async ({ request }) => {
          const data = await request.json();
          submitSpy(data);
          return HttpResponse.json({ status: "success", data });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Updated Template");
    await user.clear(screen.getByLabelText("Description"));
    await user.type(
      screen.getByLabelText("Description"),
      "Updated description",
    );
    const visibilitySelect = screen.getByLabelText("Visibility");
    await user.click(visibilitySelect);
    await waitFor(() => {
      const publicOptions = screen.getAllByText(/Public/);
      return user.click(publicOptions[0]);
    });
    await user.click(screen.getByLabelText("Approval required"));
    await user.click(
      screen.getByRole("button", { name: /update basic details/i }),
    );

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/lease_templates");
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          visibility: "PUBLIC",
          name: "Updated Template",
          description: "Updated description",
          requiresApproval: true,
        }),
      );
    });
  });

  test("displays warning when approval is not required", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(/When a user requests this lease template/i),
      ).toBeInTheDocument();
    });
  });

  test("cancels form submission and navigates back", async () => {
    renderComponent();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockNavigate).toHaveBeenCalledWith("/lease_templates");
  });

  test("validates required fields before submission", async () => {
    renderComponent();
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText("Name"));
    await user.click(
      screen.getByRole("button", { name: /update basic details/i }),
    );
    await waitFor(() => {
      expect(
        screen.getByText("Please enter a name for this lease template"),
      ).toBeInTheDocument();
    });
  });

  test("toggles approval required switch", async () => {
    renderComponent();
    const user = userEvent.setup();
    const approvalSwitch = screen.getByLabelText("Approval required");

    expect(approvalSwitch).not.toBeChecked();
    await user.click(approvalSwitch);
    expect(approvalSwitch).toBeChecked();
    await user.click(approvalSwitch);
    expect(approvalSwitch).not.toBeChecked();
  });

  test("handles API error on form submission", async () => {
    server.use(
      http.put(
        `${config.ApiUrl}/leaseTemplates/:${mockLeaseTemplate.uuid}`,
        () => {
          return HttpResponse.json(
            { status: "error", message: "API Error" },
            { status: 500 },
          );
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Updated Template");

    const submitButton = screen.getByRole("button", {
      name: /update basic details/i,
    });
    await user.click(submitButton);
    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        "HTTP error 500",
        "Whoops, something went wrong!",
      );
    });
  });
});
