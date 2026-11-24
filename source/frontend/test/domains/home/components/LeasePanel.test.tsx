// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DateTime } from "luxon";
import { BrowserRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { LeasePanel } from "@amzn/innovation-sandbox-frontend/domains/home/components/LeasePanel";
import { LeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import {
  createActiveLease,
  createExpiredLease,
  createPendingLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

// Mock the AccountLoginLink component
vi.mock(
  "@amzn/innovation-sandbox-frontend/components/AccountLoginLink",
  () => ({
    AccountLoginLink: ({ accountId }: { accountId: string }) => (
      <button>Login to account {accountId}</button>
    ),
  }),
);

const mockTerminateLease = vi.fn();
vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/hooks",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@amzn/innovation-sandbox-frontend/domains/leases/hooks")
      >();
    return {
      ...actual,
      useTerminateLease: () => ({
        mutateAsync: mockTerminateLease,
        isPending: false,
      }),
    };
  },
);

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockUseUser = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

const mockUseGetConfigurations = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/domains/settings/hooks", () => ({
  useGetConfigurations: () => mockUseGetConfigurations(),
}));

const mockShowSuccessToast = vi.fn();
const mockShowErrorToast = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: (...args: unknown[]) => mockShowSuccessToast(...args),
  showErrorToast: (...args: unknown[]) => mockShowErrorToast(...args),
}));

const ownerEmail = "owner@example.com";
const ownerUser = {
  type: "user" as const,
  email: ownerEmail,
  userId: "owner-id",
  roles: ["User" as const],
};

// Shared leases config so per-test overrides flip a single field via spread
// instead of respelling every field. createConfiguration shallow-merges the
// leases override onto schema defaults.
const defaultLeasesConfig = {
  requireMaxBudget: false,
  maxBudget: 100,
  requireMaxDuration: false,
  maxDurationHours: 999,
  maxLeasesPerUser: 2,
  ttl: 30,
  leaseSharingEnabled: false,
  allowUserLeaseTermination: true,
  leaseRequestWindowHours: 168,
  maxLeaseRequestsPerWindow: 10,
  enablePrincipalSearch: true,
};

describe("LeasePanel", () => {
  const renderComponent = (lease: LeaseView) => {
    return renderWithQueryClient(
      <ModalProvider>
        <BrowserRouter>
          <LeasePanel lease={lease as LeaseView} />
        </BrowserRouter>
      </ModalProvider>,
    );
  };

  beforeEach(() => {
    mockTerminateLease.mockReset();
    mockShowSuccessToast.mockReset();
    mockShowErrorToast.mockReset();
    mockUseUser.mockReset();
    mockUseGetConfigurations.mockReset();
    mockNavigate.mockReset();
    mockUseUser.mockReturnValue({ user: ownerUser });
    // Capability enabled so the owner-lease gate is what these tests exercise.
    mockUseGetConfigurations.mockReturnValue({
      data: createConfiguration({
        leases: defaultLeasesConfig,
        agent: { sandboxSpacesEnabled: true },
      }),
    });
  });

  test("renders active lease correctly", () => {
    const activeLease = createActiveLease({
      maxSpend: 100,
      totalCostAccrued: 25,
      lastEvaluatedSpend: 20,
    });
    renderComponent(activeLease);

    expect(
      screen.getByText(activeLease.originalLeaseTemplateName),
    ).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(activeLease.awsAccountId)).toBeInTheDocument();
    expect(
      screen.getByText(`Login to account ${activeLease.awsAccountId}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `$${activeLease.totalCostAccrued.toString()} of $${activeLease.maxSpend!.toString()}`,
      ),
    ).toBeInTheDocument();
  });

  test("links the lease title to its details page", () => {
    const activeLease: LeaseView = {
      ...createActiveLease(),
      leaseId: "encoded-lease-id",
    };
    renderComponent(activeLease);

    const titleLink = screen.getByRole("link", {
      name: `${activeLease.originalLeaseTemplateName} (${activeLease.uuid.slice(0, 8)})`,
    });
    expect(titleLink).toHaveAttribute("href", "/leases/encoded-lease-id");
  });

  test("renders pending lease correctly", () => {
    const pendingLease = createPendingLease();
    renderComponent(pendingLease);

    expect(
      screen.getByText(pendingLease.originalLeaseTemplateName),
    ).toBeInTheDocument();
    expect(screen.getByText("Pending Approval")).toBeInTheDocument();
    expect(
      screen.getByText("Your account is pending approval"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Login to account/i)).not.toBeInTheDocument();
  });

  test("renders budget information correctly for a lease with max budget", () => {
    const leaseWithBudget = createActiveLease({
      maxSpend: 1000,
      totalCostAccrued: 500,
      lastEvaluatedSpend: null,
    });

    renderComponent(leaseWithBudget);
    expect(
      screen.getByText(`Login to account ${leaseWithBudget.awsAccountId}`),
    ).toBeInTheDocument();
    expect(screen.getByText(leaseWithBudget.awsAccountId)).toBeInTheDocument();
    expect(
      screen.getByText(
        `$${leaseWithBudget.totalCostAccrued.toString()} of $${leaseWithBudget.maxSpend!.toString()}`,
      ),
    ).toBeInTheDocument();
  });

  test("shows the evaluated spend when it is above the billed total", () => {
    renderComponent(
      createActiveLease({
        maxSpend: 100,
        totalCostAccrued: 25,
        lastEvaluatedSpend: 40,
        bedrockTokenMonitoringEnabled: true,
      }),
    );

    expect(screen.getByText("$40 of $100")).toBeInTheDocument();
  });

  test("renders budget information correctly for a lease without max budget", () => {
    const leaseWithoutBudget = createActiveLease({
      maxSpend: undefined,
      totalCostAccrued: 10,
      lastEvaluatedSpend: null,
    });

    renderComponent(leaseWithoutBudget);
    expect(
      screen.getByText(`Login to account ${leaseWithoutBudget.awsAccountId}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(leaseWithoutBudget.awsAccountId),
    ).toBeInTheDocument();
    expect(screen.getByText("No max budget")).toBeInTheDocument();
    expect(
      screen.getByText(`$${leaseWithoutBudget.totalCostAccrued.toString()}`),
    ).toBeInTheDocument();
  });

  test("displays expiration date correctly", () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);
    futureDate.setMinutes(futureDate.getMinutes() + 1);
    const leaseWithFutureExpiry = createActiveLease({
      expirationDate: futureDate.toISOString(),
    });

    renderComponent(leaseWithFutureExpiry);
    expect(screen.getByText(/in 7 days/)).toBeInTheDocument();
  });

  test("handles lease without maxSpend", () => {
    const leaseWithoutMaxSpend = createActiveLease({ maxSpend: undefined });
    renderComponent(leaseWithoutMaxSpend);

    expect(screen.getByText("No max budget")).toBeInTheDocument();
  });

  test("handles lease without expirationDate", () => {
    const leaseWithoutExpiry = createPendingLease({
      leaseDurationInHours: 24,
    });
    renderComponent(leaseWithoutExpiry);

    expect(screen.getByText(/24 hours/)).toBeInTheDocument();
    expect(screen.getByText("after approval")).toBeInTheDocument();
  });

  test("describes provisioning duration relative to lease publish", () => {
    const provisioningLease = createActiveLease({
      status: "Provisioning",
      expirationDate: undefined,
      leaseDurationInHours: 24,
    });
    renderComponent(provisioningLease);

    expect(screen.getByText("24 hours")).toBeInTheDocument();
    expect(screen.getByText("from lease publish")).toBeInTheDocument();
    expect(screen.queryByText("No expiry")).not.toBeInTheDocument();
  });

  test("handles lease without expirationDate and duration", () => {
    const leaseWithoutExpiryAndDuration = createActiveLease({
      expirationDate: undefined,
      leaseDurationInHours: undefined,
    });
    renderComponent(leaseWithoutExpiryAndDuration);

    expect(screen.getByText("No expiry")).toBeInTheDocument();
  });

  test.each([
    ["Admin", "Provisioning", true],
    ["Manager", "Provisioning", false],
    ["Admin", "Frozen", true],
    ["Manager", "Frozen", true],
    ["User", "Frozen", false],
    ["User", "Active", true],
  ] as const)(
    "renders Login for %s on %s leases: %s",
    (role, status, expected) => {
      mockUseUser.mockReturnValue({
        user: { ...ownerUser, roles: [role] },
        isAdmin: role === "Admin",
        isManager: role === "Manager",
      });
      const lease = createActiveLease({ status });

      renderComponent(lease);

      const login = screen.queryByText(/Login to account/i);
      if (expected) {
        expect(login).toBeInTheDocument();
      } else {
        expect(login).not.toBeInTheDocument();
      }
    },
  );

  test.each([
    { amount: 1, unit: "hours", expected: "1 hour ago" },
    { amount: 3, unit: "hours", expected: "3 hours ago" },
    { amount: 1, unit: "days", expected: "1 day ago" },
    { amount: 3, unit: "days", expected: "3 days ago" },
    { amount: 1, unit: "months", expected: "1 month ago" },
  ])(
    "displays proper expiry date for expired lease - $expected",
    ({ amount, unit, expected }) => {
      const expirationDate = DateTime.now()
        .minus({ [unit]: amount })
        .toISO();
      const expiredLease = createExpiredLease({
        endDate: expirationDate,
      });

      renderComponent(expiredLease);

      expect(screen.getByText(expected)).toBeInTheDocument();
    },
  );

  describe("Terminate lease button visibility", () => {
    test("shows button when lease is Active, owned by current user, and feature enabled", () => {
      const lease = createActiveLease({ userEmail: ownerEmail });
      renderComponent(lease);
      expect(
        screen.getByRole("button", { name: "Terminate lease" }),
      ).toBeInTheDocument();
    });

    test("hides button when lease is owned by a different user", () => {
      const lease = createActiveLease({ userEmail: "other@example.com" });
      renderComponent(lease);
      expect(
        screen.queryByRole("button", { name: "Terminate lease" }),
      ).not.toBeInTheDocument();
    });

    test("hides button when allowUserLeaseTermination is disabled", () => {
      mockUseGetConfigurations.mockReturnValue({
        data: createConfiguration({
          leases: { ...defaultLeasesConfig, allowUserLeaseTermination: false },
        }),
      });
      const lease = createActiveLease({ userEmail: ownerEmail });
      renderComponent(lease);
      expect(
        screen.queryByRole("button", { name: "Terminate lease" }),
      ).not.toBeInTheDocument();
    });

    test("hides button when lease is not Active (e.g., Frozen)", () => {
      const lease = createActiveLease({
        userEmail: ownerEmail,
        status: "Frozen",
      });
      renderComponent(lease);
      expect(
        screen.queryByRole("button", { name: "Terminate lease" }),
      ).not.toBeInTheDocument();
    });

    test("hides button when no user is loaded yet", () => {
      mockUseUser.mockReturnValue({ user: undefined });
      const lease = createActiveLease({ userEmail: ownerEmail });
      renderComponent(lease);
      expect(
        screen.queryByRole("button", { name: "Terminate lease" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("Open Space button", () => {
    const enabledLeaseOverrides = {
      userEmail: ownerEmail,
      status: "Active" as const,
      sandboxSpacesEnabled: true,
      desiredAssignments: undefined,
    };

    test("shows button and navigates using lease.leaseId when access allowed", () => {
      const lease: LeaseView = {
        ...createActiveLease(enabledLeaseOverrides),
        leaseId: "encoded-lease-id",
      };
      renderComponent(lease);

      const button = screen.getByRole("button", { name: "Open Space" });
      expect(button).toBeInTheDocument();

      fireEvent.click(button);
      expect(mockNavigate).toHaveBeenCalledWith(
        "/leases/encoded-lease-id/sandbox-spaces",
      );
    });

    test("disables button when the viewer is not an assignee of the lease", () => {
      const lease: LeaseView = {
        ...createActiveLease({
          ...enabledLeaseOverrides,
          userEmail: "other@example.com",
        }),
        leaseId: "encoded-lease-id",
      };
      renderComponent(lease);

      const button = screen.getByRole("button", { name: "Open Space" });
      expect(button).toHaveAttribute("aria-disabled", "true");

      fireEvent.click(button);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    test("disables button when the lease is shared only with a group", () => {
      const lease: LeaseView = {
        ...createActiveLease({
          ...enabledLeaseOverrides,
          userEmail: "other@example.com",
          desiredAssignments: [
            { principalId: "group-id", principalType: "GROUP" },
          ],
        }),
        leaseId: "encoded-lease-id",
      };
      renderComponent(lease);

      expect(
        screen.getByRole("button", { name: "Open Space" }),
      ).toHaveAttribute("aria-disabled", "true");
    });

    test.each(["Admin", "Manager"] as const)(
      "disables button for a %s who is not an assignee of the lease",
      (role) => {
        mockUseUser.mockReturnValue({
          user: {
            ...ownerUser,
            email: "elevated@example.com",
            userId: "elevated-id",
            roles: ["User", role],
          },
          isAdmin: role === "Admin",
          isManager: role === "Manager",
        });
        const lease: LeaseView = {
          ...createActiveLease({
            ...enabledLeaseOverrides,
            userEmail: "other@example.com",
            desiredAssignments: [
              { principalId: "group-id", principalType: "GROUP" },
            ],
          }),
          leaseId: "encoded-lease-id",
        };
        renderComponent(lease);

        expect(
          screen.getByRole("button", { name: "Open Space" }),
        ).toHaveAttribute("aria-disabled", "true");
      },
    );

    test("hides button when sandboxSpacesEnabled is false on the lease", () => {
      const lease: LeaseView = {
        ...createActiveLease({
          ...enabledLeaseOverrides,
          sandboxSpacesEnabled: false,
        }),
        leaseId: "encoded-lease-id",
      };
      renderComponent(lease);

      expect(
        screen.queryByRole("button", { name: "Open Space" }),
      ).not.toBeInTheDocument();
    });

    test("hides button when Sandbox Spaces is globally disabled", () => {
      mockUseGetConfigurations.mockReturnValue({
        data: createConfiguration({
          leases: defaultLeasesConfig,
          agent: { sandboxSpacesEnabled: false },
        }),
      });
      const lease: LeaseView = {
        ...createActiveLease(enabledLeaseOverrides),
        leaseId: "encoded-lease-id",
      };
      renderComponent(lease);

      expect(
        screen.queryByRole("button", { name: "Open Space" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("Terminate confirmation modal", () => {
    test("opens modal with type-to-confirm input when button clicked", async () => {
      const lease = createActiveLease({ userEmail: ownerEmail });
      renderComponent(lease);

      fireEvent.click(screen.getByRole("button", { name: "Terminate lease" }));

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: "Terminate Lease" }),
        ).toBeInTheDocument();
      });
      expect(screen.getByLabelText(/To confirm, type/)).toBeInTheDocument();
    });

    test("shows the account ID and human-readable lease ID being terminated", async () => {
      const leaseWithId: LeaseView = {
        ...createActiveLease({ userEmail: ownerEmail, uuid: "lease-uuid-123" }),
        leaseId: "base64-composite-key",
      };
      renderComponent(leaseWithId);

      fireEvent.click(screen.getByRole("button", { name: "Terminate lease" }));

      const dialog = await screen.findByRole("dialog");
      // Scope to the dialog: the panel body also prints awsAccountId, so an
      // unscoped query would match twice.
      expect(
        within(dialog).getByText(leaseWithId.awsAccountId),
      ).toBeInTheDocument();
      // The modal shows the human-readable uuid, not the opaque base64 leaseId.
      expect(within(dialog).getByText("lease-uuid-123")).toBeInTheDocument();
      expect(
        within(dialog).queryByText("base64-composite-key"),
      ).not.toBeInTheDocument();
    });

    test("primary button is disabled until 'terminate' is typed", async () => {
      const lease = createActiveLease({ userEmail: ownerEmail });
      renderComponent(lease);

      fireEvent.click(screen.getByRole("button", { name: "Terminate lease" }));

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Terminate Lease" }),
        ).toBeDisabled();
      });

      const input = screen.getByLabelText(/To confirm, type/);
      fireEvent.change(input, { target: { value: "terminate" } });

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Terminate Lease" }),
        ).toBeEnabled();
      });
    });

    test("calls terminateLease mutation on confirm and fires success toast", async () => {
      mockTerminateLease.mockResolvedValueOnce(undefined);
      const leaseWithId: LeaseView = {
        ...createActiveLease({ userEmail: ownerEmail }),
        leaseId: "test-lease-id",
      };
      renderComponent(leaseWithId);

      fireEvent.click(screen.getByRole("button", { name: "Terminate lease" }));

      await waitFor(() => {
        expect(screen.getByLabelText(/To confirm, type/)).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/To confirm, type/), {
        target: { value: "terminate" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Terminate Lease" }));

      await waitFor(() => {
        expect(mockTerminateLease).toHaveBeenCalledWith("test-lease-id");
      });
      await waitFor(() => {
        expect(mockShowSuccessToast).toHaveBeenCalledWith(
          "Lease was successfully terminated.",
        );
      });
      // Modal closes after success: confirmation input no longer in DOM.
      await waitFor(() => {
        expect(
          screen.queryByLabelText(/To confirm, type/),
        ).not.toBeInTheDocument();
      });
      expect(mockShowErrorToast).not.toHaveBeenCalled();
    });

    test("fires error toast and keeps modal open when mutation rejects", async () => {
      mockTerminateLease.mockRejectedValueOnce(new Error("backend 429"));
      // Production code calls console.error for operator triage; silence it
      // so the test output stays clean. Not asserted - it's a debugging
      // affordance, not a contract. Restore at the end so the spy cannot leak
      // into tests added after this one.
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const leaseWithId: LeaseView = {
        ...createActiveLease({ userEmail: ownerEmail }),
        leaseId: "test-lease-id",
      };
      renderComponent(leaseWithId);

      fireEvent.click(screen.getByRole("button", { name: "Terminate lease" }));
      await waitFor(() => {
        expect(screen.getByLabelText(/To confirm, type/)).toBeInTheDocument();
      });
      fireEvent.change(screen.getByLabelText(/To confirm, type/), {
        target: { value: "terminate" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Terminate Lease" }));

      await waitFor(() => {
        expect(mockShowErrorToast).toHaveBeenCalledWith(
          "Lease termination failed, try again.",
          "Failed to terminate lease",
        );
      });
      // Modal stays open after failure so the user can retry.
      expect(screen.getByLabelText(/To confirm, type/)).toBeInTheDocument();
      expect(mockShowSuccessToast).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });
});
