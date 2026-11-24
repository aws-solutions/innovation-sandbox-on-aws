// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { SandboxAccountView } from "@amzn/innovation-sandbox-frontend/domains/accounts/model";
import { AccountDetails } from "@amzn/innovation-sandbox-frontend/domains/accounts/pages/AccountDetails";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { createSandboxAccount } from "@amzn/innovation-sandbox-frontend/mocks/factories/accountFactory";
import { createActiveLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

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

vi.mock(
  "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext",
  () => ({
    useAppLayoutContext: () => ({ setTools: vi.fn() }),
  }),
);

function setupAccountApi(account: SandboxAccountView) {
  server.use(
    http.get(`${getConfig().ApiUrl}/accounts/${account.awsAccountId}`, () => {
      return HttpResponse.json({
        status: "success",
        data: account,
      });
    }),
    http.get(
      `${getConfig().ApiUrl}/accounts/${account.awsAccountId}/cleanup-reports`,
      () => {
        return HttpResponse.json({
          status: "success",
          data: { result: [], nextPageIdentifier: null },
        });
      },
    ),
  );
}

function renderComponent(accountId: string) {
  return renderWithQueryClient(
    <ModalProvider>
      <MemoryRouter initialEntries={[`/accounts/${accountId}`]}>
        <Routes>
          <Route path="/accounts/:accountId" element={<AccountDetails />} />
          <Route path="/accounts" element={<div>Accounts List</div>} />
        </Routes>
      </MemoryRouter>
    </ModalProvider>,
  );
}

describe("AccountDetails", () => {
  test("renders account details with account ID", async () => {
    const account = createSandboxAccount({ status: "Available" });
    setupAccountApi(account);

    renderComponent(account.awsAccountId);

    expect(await screen.findByText("Account details")).toBeInTheDocument();
  });

  test("shows 'Not leased' when account has no current lease", async () => {
    const account = createSandboxAccount({
      status: "Available",
      currentLease: undefined,
    });
    setupAccountApi(account);

    renderComponent(account.awsAccountId);

    await waitFor(() => {
      expect(screen.getByText("Not leased")).toBeInTheDocument();
    });
  });

  test("shows lease template name link when account has a current lease", async () => {
    const leaseUuid = "550e8400-e29b-41d4-a716-446655440000";
    const account = createSandboxAccount({
      status: "Active",
      currentLease: {
        leaseId: leaseUuid,
        ownerEmail: "testuser@example.com",
      },
    });
    setupAccountApi(account);

    // The page resolves the lease template name by fetching the full lease.
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/:leaseId`, () => {
        return HttpResponse.json({
          status: "success",
          data: createActiveLease({
            uuid: leaseUuid,
            originalLeaseTemplateName: "MyTemplate",
          }),
        });
      }),
    );

    renderComponent(account.awsAccountId);

    // Rendered via the shared LeaseName component: `<templateName> (<first8>)`.
    await waitFor(() => {
      expect(screen.getByText("MyTemplate (550e8400)")).toBeInTheDocument();
    });

    const link = screen.getByText("MyTemplate (550e8400)");
    expect(link.closest("a")).toHaveAttribute(
      "href",
      expect.stringContaining("/leases/"),
    );
  });

  test("disables eject button when account is in CleanUp status", async () => {
    const account = createSandboxAccount({ status: "CleanUp" });
    setupAccountApi(account);

    renderComponent(account.awsAccountId);

    await waitFor(() => {
      expect(screen.getByText("Eject account")).toBeInTheDocument();
    });

    const ejectButton = screen.getByRole("button", { name: "Eject account" });
    expect(ejectButton).toBeDisabled();
  });

  test("enables eject button when account is not in CleanUp status", async () => {
    const account = createSandboxAccount({ status: "Available" });
    setupAccountApi(account);

    renderComponent(account.awsAccountId);

    await waitFor(() => {
      expect(screen.getByText("Eject account")).toBeInTheDocument();
    });

    const ejectButton = screen.getByRole("button", { name: "Eject account" });
    expect(ejectButton).not.toBeDisabled();
  });

  test("eject modal warns about cleanup and requires typing 'eject' to enable submit", async () => {
    const user = userEvent.setup();
    const account = createSandboxAccount({ status: "Available" });
    setupAccountApi(account);

    renderComponent(account.awsAccountId);

    await waitFor(() => {
      expect(screen.getByText("Eject account")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Eject account" }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("eject")).toBeInTheDocument();
    });

    const modal = screen.getByRole("dialog");
    expect(modal).toHaveTextContent(/does not run account cleanup/i);
    expect(modal).toHaveTextContent(/continue to incur charges/i);

    // Submit button should be disabled initially
    const submitButton = screen.getByRole("button", { name: "Eject" });
    expect(submitButton).toBeDisabled();

    // Type "eject" in the confirmation input
    const input = screen.getByPlaceholderText("eject");
    await user.type(input, "eject");

    // Submit button should now be enabled
    expect(submitButton).not.toBeDisabled();
  });

  test("disables start cleanup button for Available accounts", async () => {
    const account = createSandboxAccount({ status: "Available" });
    setupAccountApi(account);

    renderComponent(account.awsAccountId);

    await waitFor(() => {
      expect(screen.getByText("Start cleanup")).toBeInTheDocument();
    });

    const cleanupButton = screen.getByRole("button", { name: "Start cleanup" });
    expect(cleanupButton).toBeDisabled();
  });

  test("enables start cleanup button for Quarantine accounts", async () => {
    const account = createSandboxAccount({
      status: "Quarantine",
      resourceLock: undefined,
    });
    setupAccountApi(account);

    renderComponent(account.awsAccountId);

    await waitFor(() => {
      expect(screen.getByText("Start cleanup")).toBeInTheDocument();
    });

    const cleanupButton = screen.getByRole("button", { name: "Start cleanup" });
    expect(cleanupButton).not.toBeDisabled();
  });

  test("disables start cleanup while a cleanup lock is live (execution already running)", async () => {
    // A live (non-expired) resource lock means a cleanup execution is running;
    // dispatching a second one would race it, so the button must be disabled
    // even though the CleanUp status would otherwise allow a retry.
    const account = createSandboxAccount({
      status: "CleanUp",
      resourceLock: {
        ownerId: "cleanup-execution",
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
    });
    setupAccountApi(account);

    renderComponent(account.awsAccountId);

    await waitFor(() => {
      expect(screen.getByText("Start cleanup")).toBeInTheDocument();
    });

    // With a disabledReason set, Cloudscape renders the button aria-disabled
    // (kept focusable so the reason tooltip is reachable), not natively
    // disabled — same convention as the Settings Save button.
    const cleanupButton = screen.getByRole("button", { name: "Start cleanup" });
    expect(cleanupButton).toHaveAttribute("aria-disabled", "true");
  });

  test("enables start cleanup once the cleanup lock has expired (stuck-cleanup recovery)", async () => {
    // An expired lock is exactly the stuck-execution case the retry exists to
    // recover, so it must NOT block the button.
    const account = createSandboxAccount({
      status: "CleanUp",
      resourceLock: {
        ownerId: "cleanup-execution",
        acquiredAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    setupAccountApi(account);

    renderComponent(account.awsAccountId);

    await waitFor(() => {
      expect(screen.getByText("Start cleanup")).toBeInTheDocument();
    });

    const cleanupButton = screen.getByRole("button", { name: "Start cleanup" });
    expect(cleanupButton).not.toBeDisabled();
    // Not aria-disabled either: a lock-gated button is disabled via
    // disabledReason (aria-disabled, not native), which not.toBeDisabled()
    // alone would miss.
    expect(cleanupButton).not.toHaveAttribute("aria-disabled", "true");
  });

  test("navigates to accounts list after successful eject", async () => {
    const user = userEvent.setup();
    const account = createSandboxAccount({ status: "Available" });
    setupAccountApi(account);

    server.use(
      http.post(
        `${getConfig().ApiUrl}/accounts/${account.awsAccountId}/eject`,
        () => {
          return HttpResponse.json({
            status: "success",
            data: null,
          });
        },
      ),
    );

    renderComponent(account.awsAccountId);

    await waitFor(() => {
      expect(screen.getByText("Eject account")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Eject account" }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("eject")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("eject"), "eject");
    await user.click(screen.getByRole("button", { name: "Eject" }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/accounts");
    });
  });
});
