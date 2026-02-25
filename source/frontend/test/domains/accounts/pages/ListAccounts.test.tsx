// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { SandboxAccount } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { ListAccounts } from "@amzn/innovation-sandbox-frontend/domains/accounts/pages/ListAccounts";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { mockAccounts } from "@amzn/innovation-sandbox-frontend/mocks/handlers/accountHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import {
  ApiPaginatedResult,
  ApiResponse,
} from "@amzn/innovation-sandbox-frontend/types";

// Mock ResizeObserver
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;

const mockNavigate = vi.fn();
const mockSetBreadcrumb = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => mockSetBreadcrumb,
}));

describe("ListAccounts", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <ModalProvider>
        <Router>
          <ListAccounts />
        </Router>
      </ModalProvider>,
    );

  test("renders the component with correct structure", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Accounts", level: 1 }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Manage registered AWS accounts in the account pool"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Add accounts" }),
      ).toBeInTheDocument();
    });

    expect(
      await screen.findByText(mockAccounts[0].awsAccountId),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(mockAccounts[1].awsAccountId),
    ).toBeInTheDocument();
  });

  test("navigates to add accounts page when 'Add accounts' button is clicked", async () => {
    renderComponent();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add accounts" }));

    expect(mockNavigate).toHaveBeenCalledWith("/accounts/new");
  });

  test("sets breadcrumb correctly", async () => {
    renderComponent();

    await waitFor(() => {
      expect(mockSetBreadcrumb).toHaveBeenCalledWith([
        { text: "Home", href: "/" },
        { text: "Accounts", href: "/accounts" },
      ]);
    });
  });

  test("displays loading state while fetching accounts", async () => {
    server.use(
      http.get(`${config.ApiUrl}/accounts`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return HttpResponse.json({
          status: "success",
          data: {
            result: mockAccounts,
            nextPageIdentifier: null,
          },
        } as ApiResponse<ApiPaginatedResult<SandboxAccount>>);
      }),
    );

    renderComponent();

    expect(screen.getByText("Loading account info...")).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.queryByText("Loading account info..."),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(mockAccounts[0].awsAccountId),
      ).toBeInTheDocument();
    });
  });

  test("allows selecting accounts and enables action buttons", async () => {
    renderComponent();
    const user = userEvent.setup();

    await screen.findByText(mockAccounts[0].awsAccountId);

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    expect(screen.getByText("Actions")).not.toBeDisabled();
  });

  test("refreshes account data when refresh button is clicked", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${config.ApiUrl}/accounts`, () => {
        requestCount++;
        return HttpResponse.json({
          status: "success",
          data: {
            result: requestCount === 1 ? mockAccounts : [mockAccounts[0]],
            nextPageIdentifier: null,
          },
        } as ApiResponse<ApiPaginatedResult<SandboxAccount>>);
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await screen.findByText(mockAccounts[0].awsAccountId);
    await screen.findByText(mockAccounts[1].awsAccountId);

    const refreshButton = screen.getByTestId("refresh-button");
    expect(refreshButton).not.toBeDisabled();
    await user.click(refreshButton);

    await waitFor(() => {
      expect(
        screen.getByText(mockAccounts[0].awsAccountId),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(mockAccounts[1].awsAccountId),
      ).not.toBeInTheDocument();
    });
  });

  test("filters accounts based on status", async () => {
    const user = userEvent.setup();
    renderComponent();

    await screen.findByText(mockAccounts[0].awsAccountId);
    await screen.findByText(mockAccounts[1].awsAccountId);
    const filterInput = screen.getByPlaceholderText("Search");

    await user.type(filterInput, "Available");
    await waitFor(() => {
      expect(
        screen.getByText(mockAccounts[0].awsAccountId),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(mockAccounts[1].awsAccountId),
      ).not.toBeInTheDocument();
    });

    await user.clear(filterInput);

    await waitFor(() => {
      expect(
        screen.getByText(mockAccounts[0].awsAccountId),
      ).toBeInTheDocument();
      expect(
        screen.getByText(mockAccounts[1].awsAccountId),
      ).toBeInTheDocument();
    });
  });

  test("enables action buttons when accounts are selected", async () => {
    renderComponent();
    await screen.findByText(mockAccounts[0].awsAccountId);

    const checkbox = screen.getAllByRole("checkbox")[1];
    userEvent.click(checkbox);

    expect(screen.getByText("Actions")).not.toBeDisabled();
  });

  test("opens eject modal when 'Eject account' is selected", async () => {
    renderComponent();
    const user = userEvent.setup();

    const account = mockAccounts.find(
      (account) => account.status === "Available",
    );

    await screen.findByText(account!.awsAccountId);

    const row = screen.getByText(account!.awsAccountId).closest("tr");
    const checkbox = within(row!).getByRole("checkbox");
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const ejectOption = await screen.findByText("Eject account");
    await user.click(ejectOption);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);

    expect(modalContent.getByText("1 account(s) to eject")).toBeInTheDocument();

    await waitFor(() =>
      expect(modalContent.getByText(account!.awsAccountId)).toBeInTheDocument(),
    );
  });

  test("disables 'Retry cleanup' when a non-quarantine account is selected", async () => {
    renderComponent();
    const user = userEvent.setup();

    await screen.findByRole("table");

    // Available cannot attempt retry cleanup
    const filteredAccounts = mockAccounts.filter(
      (account) =>
        account.status === "Available" || account.status === "CleanUp",
    );

    for (const account of filteredAccounts) {
      await screen.findByText(account.awsAccountId);
      const row = screen.getByText(account.awsAccountId).closest("tr");
      const checkbox = within(row!).getByRole("checkbox");
      await user.click(checkbox);
    }

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const cleanupOption = await screen.findByText("Retry cleanup");

    // The option should be disabled
    const menuItem = cleanupOption.closest('[role="menuitem"]');
    expect(menuItem).toHaveAttribute("aria-disabled", "true");
  });

  test("opens cleanup modal when 'Retry cleanup' is selected", async () => {
    renderComponent();
    const user = userEvent.setup();

    await screen.findByRole("table");

    // Both Quarantine and CleanUp can attempt retry cleanup
    const filteredAccounts = mockAccounts.filter(
      (account) =>
        account.status === "Quarantine" || account.status === "CleanUp",
    );

    for (const account of filteredAccounts) {
      await screen.findByText(account.awsAccountId);
      const row = screen.getByText(account.awsAccountId).closest("tr");
      const checkbox = within(row!).getByRole("checkbox");
      await user.click(checkbox);
    }

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const cleanupOption = await screen.findByText("Retry cleanup");
    await user.click(cleanupOption);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);

    expect(
      modalContent.getByText(
        `${filteredAccounts.length} account(s) to retry cleanup`,
      ),
    ).toBeInTheDocument();

    await waitFor(() =>
      expect(
        modalContent.getByText(filteredAccounts[0].awsAccountId),
      ).toBeInTheDocument(),
    );
  });

  test("displays login link for accounts", async () => {
    renderComponent();

    await screen.findByText(mockAccounts[0].awsAccountId);

    const loginLinks = screen.getAllByText("Login to account");
    expect(loginLinks.length).toBeGreaterThan(0);
  });

  test("updates account status indicators correctly", async () => {
    renderComponent();

    await screen.findByText(mockAccounts[0].awsAccountId);

    // Find all status indicators
    const statusIndicators = screen.getAllByText(/Available|Active/);

    // Check if both statuses are present
    expect(
      statusIndicators.some((element) => element.textContent === "Available"),
    ).toBe(true);
    expect(
      statusIndicators.some((element) => element.textContent === "Active"),
    ).toBe(true);
  });

  test("displays account name or N/A when name is missing", async () => {
    const accountsWithMissingName = [
      { ...mockAccounts[0], name: "Test Account" },
      { ...mockAccounts[1], name: undefined },
    ];

    server.use(
      http.get(`${config.ApiUrl}/accounts`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            result: accountsWithMissingName,
            nextPageIdentifier: null,
          },
        } as ApiResponse<ApiPaginatedResult<SandboxAccount>>);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Test Account")).toBeInTheDocument();
      // Verify N/A is displayed for missing name - check in the document
      expect(screen.getAllByText("N/A").length).toBeGreaterThan(0);
    });
  });

  test("displays account email or N/A when email is missing", async () => {
    const accountsWithMissingEmail = [
      { ...mockAccounts[0], email: "test@example.com" },
      { ...mockAccounts[1], email: undefined },
    ];

    server.use(
      http.get(`${config.ApiUrl}/accounts`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            result: accountsWithMissingEmail,
            nextPageIdentifier: null,
          },
        } as ApiResponse<ApiPaginatedResult<SandboxAccount>>);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("test@example.com")).toBeInTheDocument();
      // Verify N/A is displayed for missing email - check in the document
      expect(screen.getAllByText("N/A").length).toBeGreaterThan(0);
    });
  });

  test("successfully ejects account and shows success toast", async () => {
    server.use(
      http.post(`${config.ApiUrl}/accounts/:accountId/eject`, () => {
        return HttpResponse.json({
          status: "success",
          data: {},
        });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    const account = mockAccounts.find(
      (account) => account.status === "Available",
    );

    await screen.findByText(account!.awsAccountId);

    const row = screen.getByText(account!.awsAccountId).closest("tr");
    const checkbox = within(row!).getByRole("checkbox");
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const ejectOption = await screen.findByText("Eject account");
    await user.click(ejectOption);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getAllByText("Success")).toHaveLength(1);
    });
  });

  test("handles eject account failure and shows error", async () => {
    server.use(
      http.post(`${config.ApiUrl}/accounts/:accountId/eject`, () => {
        return HttpResponse.json(
          {
            status: "error",
            message: "Failed to eject account",
          },
          { status: 500 },
        );
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    const account = mockAccounts.find(
      (account) => account.status === "Available",
    );

    await screen.findByText(account!.awsAccountId);

    const row = screen.getByText(account!.awsAccountId).closest("tr");
    const checkbox = within(row!).getByRole("checkbox");
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const ejectOption = await screen.findByText("Eject account");
    await user.click(ejectOption);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
  });

  test("successfully retries cleanup and shows success", async () => {
    server.use(
      http.post(`${config.ApiUrl}/accounts/:accountId/retryCleanup`, () => {
        return HttpResponse.json({
          status: "success",
          data: {},
        });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await screen.findByRole("table");

    const filteredAccounts = mockAccounts.filter(
      (account) =>
        account.status === "Quarantine" || account.status === "CleanUp",
    );

    for (const account of filteredAccounts) {
      await screen.findByText(account.awsAccountId);
      const row = screen.getByText(account.awsAccountId).closest("tr");
      const checkbox = within(row!).getByRole("checkbox");
      await user.click(checkbox);
    }

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const cleanupOption = await screen.findByText("Retry cleanup");
    await user.click(cleanupOption);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getAllByText("Success")).toHaveLength(
        filteredAccounts.length,
      );
    });
  });

  test("handles cleanup failure and shows error", async () => {
    server.use(
      http.post(`${config.ApiUrl}/accounts/:accountId/retryCleanup`, () => {
        return HttpResponse.json(
          {
            status: "error",
            message: "Failed to cleanup account",
          },
          { status: 500 },
        );
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await screen.findByRole("table");

    const filteredAccounts = mockAccounts.filter(
      (account) =>
        account.status === "Quarantine" || account.status === "CleanUp",
    );

    for (const account of filteredAccounts) {
      await screen.findByText(account.awsAccountId);
      const row = screen.getByText(account.awsAccountId).closest("tr");
      const checkbox = within(row!).getByRole("checkbox");
      await user.click(checkbox);
    }

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const cleanupOption = await screen.findByText("Retry cleanup");
    await user.click(cleanupOption);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(screen.getAllByText("Failed")).toHaveLength(
        filteredAccounts.length,
      );
    });
  });
});
