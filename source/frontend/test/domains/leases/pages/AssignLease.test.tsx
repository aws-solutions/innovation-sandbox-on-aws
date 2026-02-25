// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { AssignLease } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/AssignLease";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  mockAdvancedLeaseTemplate,
  mockBasicLeaseTemplate,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import {
  ApiPaginatedResult,
  ApiResponse,
} from "@amzn/innovation-sandbox-frontend/types";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

describe("AssignLease", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <AssignLease />
      </Router>,
    );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Get mocked functions
  const mockedShowSuccessToast = vi.mocked(showSuccessToast);
  const mockedShowErrorToast = vi.mocked(showErrorToast);

  test("renders the assign lease form with correct title and description", async () => {
    renderComponent();

    expect(await screen.findByText("Assign lease")).toBeInTheDocument();
    expect(
      screen.getByText("Create a lease assignment for another user."),
    ).toBeInTheDocument();
  });

  test("correctly renders the wizard with all steps", async () => {
    renderComponent();

    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(1, "active")).not.toBeNull();
      expect(wizard?.findMenuNavigationLink(2, "disabled")).not.toBeNull();
      expect(wizard?.findMenuNavigationLink(3, "disabled")).not.toBeNull();
      expect(wizard?.findMenuNavigationLink(4, "disabled")).not.toBeNull();
    });

    // Check step titles using wizard navigation
    const wizard = createWrapper().findWizard();
    expect(
      wizard?.findMenuNavigationLink(1)?.getElement().textContent,
    ).toContain("Select lease template");
    expect(
      wizard?.findMenuNavigationLink(2)?.getElement().textContent,
    ).toContain("Select user");
    expect(
      wizard?.findMenuNavigationLink(3)?.getElement().textContent,
    ).toContain("Terms of Service");
    expect(
      wizard?.findMenuNavigationLink(4)?.getElement().textContent,
    ).toContain("Review & Submit");
  });

  test("displays the lease templates in step 1", async () => {
    renderComponent();

    await waitFor(() => {
      const cards = createWrapper().findCards();
      expect(cards?.findItems()).toHaveLength(2);

      const cardHeaders = cards
        ?.findItems()
        .map((item) => item.findCardHeader()?.getElement().textContent);
      expect(cardHeaders).toContain(mockBasicLeaseTemplate.name);
      expect(cardHeaders).toContain(mockAdvancedLeaseTemplate.name);
    });

    expect(
      screen.getByText(
        "What lease template would you like to use for this assignment?",
      ),
    ).toBeInTheDocument();
  });

  test("prevents navigation to next step without selecting a template", async () => {
    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });

    const nextButton = await screen.findByRole("button", { name: /next/i });
    await user.click(nextButton);

    // Should show error and stay on step 1
    expect(
      screen.getByText("You must choose a lease template"),
    ).toBeInTheDocument();

    const wizard = createWrapper().findWizard();
    expect(wizard?.findMenuNavigationLink(1, "active")).not.toBeNull();
  });

  test("allows navigation to step 2 after selecting a template", async () => {
    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });

    // Select a lease template
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);

    const nextButton = await screen.findByRole("button", { name: /next/i });
    await user.click(nextButton);

    // Should navigate to step 2
    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(2, "active")).not.toBeNull();
    });
  });

  test("validates email input in step 2", async () => {
    const user = userEvent.setup();
    renderComponent();

    // Navigate to step 2
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Try to proceed without email
    await user.click(await screen.findByRole("button", { name: /next/i }));
    expect(
      screen.getByText("You must provide a user email"),
    ).toBeInTheDocument();

    // Enter invalid email
    const emailInput = screen.getByRole("textbox");
    await user.type(emailInput, "invalid-email");
    await user.click(await screen.findByRole("button", { name: /next/i }));
    expect(
      screen.getByText("You must provide a valid email address"),
    ).toBeInTheDocument();

    // Enter valid email
    await user.clear(emailInput);
    await user.type(emailInput, "user@example.com");
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Should navigate to step 3
    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(3, "active")).not.toBeNull();
    });
  });

  test("validates terms acceptance in step 3", async () => {
    const user = userEvent.setup();
    renderComponent();

    // Navigate to step 3
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const emailInput = screen.getByRole("textbox");
    await user.type(emailInput, "user@example.com");
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Try to proceed without accepting terms
    await user.click(await screen.findByRole("button", { name: /next/i }));
    expect(
      screen.getByText("You must accept the terms of service to continue"),
    ).toBeInTheDocument();

    // Accept terms
    const termsCheckbox = screen.getByLabelText(
      "I accept the above terms of service on behalf of the assigned user.",
    );
    await user.click(termsCheckbox);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Should navigate to step 4
    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(4, "active")).not.toBeNull();
    });
  });

  test("displays review information in step 4", async () => {
    const user = userEvent.setup();
    renderComponent();

    // Navigate through all steps
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const emailInput = screen.getByRole("textbox");
    await user.type(emailInput, "user@example.com");
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const termsCheckbox = screen.getByLabelText(
      "I accept the above terms of service on behalf of the assigned user.",
    );
    await user.click(termsCheckbox);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Check review step content
    expect(screen.getAllByText("Review & Submit")).toHaveLength(3);
    expect(screen.getByText("Comments")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Enter any additional comments..."),
    ).toBeInTheDocument();
  });

  test("submits the form successfully and navigates", async () => {
    const user = userEvent.setup();

    server.use(
      http.post(`${config.ApiUrl}/leases`, async ({ request }) => {
        const body = (await request.json()) as {
          userEmail: string;
          leaseTemplateUuid: string;
          comments: string;
        };

        expect(body.userEmail).toBe("user@example.com");
        expect(body.leaseTemplateUuid).toBe(mockBasicLeaseTemplate.uuid);
        expect(body.comments).toBe("Test comments");

        return HttpResponse.json({
          status: "success",
          data: {
            uuid: "new-lease-uuid",
            userEmail: body.userEmail,
            status: "Active",
            awsAccountId: "123456789012",
          },
        });
      }),
    );

    renderComponent();

    // Complete the wizard
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const emailInput = screen.getByRole("textbox");
    await user.type(emailInput, "user@example.com");
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const termsCheckbox = screen.getByLabelText(
      "I accept the above terms of service on behalf of the assigned user.",
    );
    await user.click(termsCheckbox);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const commentsTextarea = screen.getByPlaceholderText(
      "Enter any additional comments...",
    );
    await user.type(commentsTextarea, "Test comments");

    // Submit the form
    const submitButton = await screen.findByRole("button", {
      name: /assign lease/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/");
      expect(mockedShowSuccessToast).toHaveBeenCalledWith(
        "Lease has been assigned to user@example.com.",
      );
    });
  });

  test("handles form submission error", async () => {
    const user = userEvent.setup();

    server.use(
      http.post(`${config.ApiUrl}/leases`, () => {
        return HttpResponse.json(
          { status: "error", message: "API Error" },
          { status: 500 },
        );
      }),
    );

    renderComponent();

    // Complete the wizard
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const emailInput = screen.getByRole("textbox");
    await user.type(emailInput, "user@example.com");
    await user.click(await screen.findByRole("button", { name: /next/i }));

    const termsCheckbox = screen.getByLabelText(
      "I accept the above terms of service on behalf of the assigned user.",
    );
    await user.click(termsCheckbox);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Submit the form
    const submitButton = await screen.findByRole("button", {
      name: /assign lease/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockedShowErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to submit lease assignment"),
      );
    });
  });

  test("allows navigation backwards through steps", async () => {
    const user = userEvent.setup();
    renderComponent();

    // Navigate to step 2
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);
    await user.click(await screen.findByRole("button", { name: /next/i }));

    // Navigate back to step 1
    const previousButton = await screen.findByRole("button", {
      name: /previous/i,
    });
    await user.click(previousButton);

    await waitFor(() => {
      const wizard = createWrapper().findWizard();
      expect(wizard?.findMenuNavigationLink(1, "active")).not.toBeNull();
    });
  });

  test("handles cancel action", async () => {
    const user = userEvent.setup();
    renderComponent();

    const cancelButton = await screen.findByRole("button", { name: /cancel/i });
    await user.click(cancelButton);

    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  test("displays error when no lease templates are available", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates`, () => {
        const response: ApiResponse<ApiPaginatedResult<LeaseTemplate>> = {
          status: "success",
          data: {
            result: [],
            nextPageIdentifier: null,
          },
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("No lease templates configured."),
      ).toBeInTheDocument();
    });
  });

  test("clears validation errors when user corrects input", async () => {
    const user = userEvent.setup();
    renderComponent();

    // Try to proceed without selecting template
    const nextButton = await screen.findByRole("button", { name: /next/i });
    await user.click(nextButton);

    expect(
      screen.getByText("You must choose a lease template"),
    ).toBeInTheDocument();

    // Select template - error should clear
    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
    const leaseTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(leaseTemplateCard);

    expect(
      screen.queryByText("You must choose a lease template"),
    ).not.toBeInTheDocument();
  });
});
