// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper, {
  ButtonWrapper,
} from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  LeaseView,
  MonitoredLeaseView,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { ListLeases } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/ListLeases";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import {
  createActiveLease,
  createApprovalDeniedLease,
  createExpiredLease,
  createPendingLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import {
  mockConfigurationApi,
  mockLeaseApi,
} from "@amzn/innovation-sandbox-frontend/mocks/mockApi";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

// Mock ResizeObserver
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;

const mockCurrentUserRoles = vi.hoisted(() => ({
  current: ["Admin"] as Array<"Admin" | "Manager" | "User">,
}));

// Mock the useBreadcrumb hook
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
}));

// Default to Admin so all tabs and bulk actions are visible. Individual tests
// can replace the roles before rendering to exercise role-specific behavior.
vi.mock(
  "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService",
  async () => {
    const [
      { authenticated, mockAuthenticatedUser },
      { buildCognitoAuthServiceMock },
    ] = await Promise.all([
      import("@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures"),
      import("@amzn/innovation-sandbox-frontend-test/utils/cognitoServiceMock"),
    ]);
    return {
      CognitoAuthService: buildCognitoAuthServiceMock({
        getCurrentUser: vi.fn().mockImplementation(() =>
          Promise.resolve(
            authenticated({
              ...mockAuthenticatedUser,
              roles: mockCurrentUserRoles.current,
            }),
          ),
        ),
      }),
    };
  },
);

// Mock the navigate function
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock(
  "@amzn/innovation-sandbox-frontend/components/BudgetProgressBar",
  () => ({
    BudgetProgressBar: ({
      currentValue,
      maxValue,
    }: {
      currentValue: number;
      maxValue: number;
    }) => (
      <div
        data-testid="budget-progress-bar"
        data-current={currentValue}
        data-max={maxValue}
      />
    ),
  }),
);

describe("ListLeases", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <ModalProvider>
        <MemoryRouter initialEntries={["/leases"]}>
          <ListLeases />
        </MemoryRouter>
      </ModalProvider>,
    );

  const testUserEmail = "test@example.com";
  const testUuid = "00000000-0000-0000-0000-000000000000";
  const testLeaseId = btoa(
    JSON.stringify({
      userEmail: testUserEmail,
      uuid: testUuid,
    }),
  );

  const mockActiveLease: MonitoredLeaseView = {
    ...createActiveLease({
      userEmail: testUserEmail,
      uuid: testUuid,
      originalLeaseTemplateName: "Basic Template",
      status: "Active",
      awsAccountId: "123456789012",
      totalCostAccrued: 100,
      lastEvaluatedSpend: null,
      maxSpend: 1000,
    }),
    leaseId: testLeaseId,
  };

  const mockFrozenLease: MonitoredLeaseView = {
    ...createActiveLease({
      userEmail: testUserEmail,
      uuid: testUuid,
      originalLeaseTemplateName: "Basic Template",
      status: "Frozen",
      awsAccountId: "123456789012",
      totalCostAccrued: 100,
      maxSpend: 1000,
    }),
    leaseId: testLeaseId,
  };

  const mockPendingLease = createPendingLease({
    userEmail: "pending@example.com",
    originalLeaseTemplateName: "Advanced Template",
    status: "PendingApproval",
  });

  const mockExpiredLease = createExpiredLease({
    userEmail: "expired@example.com",
    originalLeaseTemplateName: "Expired Template",
    status: "Expired",
    awsAccountId: "210987654321",
  });

  beforeEach(() => {
    mockCurrentUserRoles.current = ["Admin"];
    const mockConfig = createConfiguration({});
    mockConfigurationApi.returns(mockConfig);
    server.use(mockConfigurationApi.getHandler());

    // Default: shared leases return empty
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/shared`, () => {
        return HttpResponse.json({
          status: "success",
          data: { result: [], nextPageIdentifier: null },
        });
      }),
    );
  });

  // ─── Page Structure Tests ──────────────────────────────────────────────────

  test("renders the page header correctly", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    const wrapper = createWrapper();
    const header = wrapper.findHeader();
    expect(header?.findHeadingText()?.getElement()).toHaveTextContent("Leases");
    expect(header?.findDescription()?.getElement()).toHaveTextContent(
      "Manage sandbox account leases",
    );
  });

  test("renders tabs for All Leases, My Leases, and Shared with me", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    const wrapper = createWrapper();
    const tabs = wrapper.findTabs();
    expect(tabs).not.toBeNull();

    // Verify the three tabs exist
    expect(
      screen.getByRole("tab", { name: /All Leases/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /My Leases/i })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /Shared with me/i }),
    ).toBeInTheDocument();
  });

  test("All Leases tab is active by default", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    const allTab = screen.getByRole("tab", { name: /All Leases/i });
    expect(allTab).toHaveAttribute("aria-selected", "true");
  });

  test("renders Request lease button in header", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    expect(
      screen.getByRole("button", { name: /Request lease/i }),
    ).toBeInTheDocument();
  });

  test("renders Assign lease button for admin users", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Assign lease/i }),
      ).toBeInTheDocument();
    });
  });

  test("navigates to /request when Request lease is clicked", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();
    const user = userEvent.setup();

    const requestButton = screen.getByRole("button", {
      name: /Request lease/i,
    });
    await user.click(requestButton);

    expect(mockNavigate).toHaveBeenCalledWith("/request");
  });

  // ─── All Leases Tab (Admin) ────────────────────────────────────────────────

  test("displays leases in the All Leases tab", async () => {
    mockLeaseApi.returns([mockActiveLease, mockPendingLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });
  });

  test("shows table counter with item count (default status filter applied)", async () => {
    // Default filter shows PendingApproval/Active/Frozen/Provisioning, so the
    // expired lease is filtered out: 2 of 3 total.
    mockLeaseApi.returns([mockActiveLease, mockPendingLease, mockExpiredLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("(2/3)")).toBeInTheDocument();
    });
  });

  test("shows leases with default status filter (PendingApproval, Active, Frozen, Provisioning visible; all others hidden)", async () => {
    // Create one lease per status to verify the default filter behavior
    const makeLease = (
      status: LeaseView["status"],
      email: string,
    ): LeaseView => {
      const common = {
        userEmail: email,
        uuid: testUuid,
        originalLeaseTemplateName: `${status} Template`,
      };
      let lease: LeaseView;
      switch (status) {
        case "PendingApproval":
          lease = createPendingLease(common);
          break;
        case "ApprovalDenied":
          lease = createApprovalDeniedLease(common);
          break;
        case "Active":
        case "Frozen":
        case "Provisioning":
          lease = createActiveLease({
            ...common,
            status,
            awsAccountId: "123456789012",
            totalCostAccrued: 0,
            maxSpend: 1000,
          });
          break;
        default:
          lease = createExpiredLease({
            ...common,
            status,
            awsAccountId: "123456789012",
            totalCostAccrued: 0,
            maxSpend: 1000,
          });
      }
      return {
        ...lease,
        leaseId: btoa(JSON.stringify({ userEmail: email, uuid: testUuid })),
      };
    };

    // Statuses that should be VISIBLE by default
    const visibleLeases = [
      makeLease("PendingApproval", "pending@example.com"),
      makeLease("Active", "active@example.com"),
      makeLease("Frozen", "frozen@example.com"),
      makeLease("Provisioning", "provisioning@example.com"),
    ];

    // Statuses that should be HIDDEN by default
    const hiddenLeases = [
      makeLease("Expired", "expired@example.com"),
      makeLease("ManuallyTerminated", "terminated@example.com"),
      makeLease("ApprovalDenied", "denied@example.com"),
      makeLease("ProvisioningFailed", "provfailed@example.com"),
    ];

    mockLeaseApi.returns([...visibleLeases, ...hiddenLeases]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    // Wait for leases to load
    await waitFor(() => {
      expect(screen.getByText("active@example.com")).toBeInTheDocument();
    });

    // Verify all default-visible statuses are shown
    for (const lease of visibleLeases) {
      expect(screen.getByText(lease.userEmail)).toBeInTheDocument();
    }

    // Verify all non-default statuses are hidden
    for (const lease of hiddenLeases) {
      expect(screen.queryByText(lease.userEmail)).not.toBeInTheDocument();
    }
  });

  test("renders lease name alias as link", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(
          `${mockActiveLease.originalLeaseTemplateName} (${testUuid.slice(0, 8)})`,
        ),
      ).toBeInTheDocument();
    });
  });

  test("renders account login link for active leases", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    await waitFor(
      () => {
        expect(screen.getByText("Login")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  test.each([
    ["Admin", "Provisioning", true],
    ["Manager", "Provisioning", false],
    ["Manager", "Frozen", true],
    ["User", "Frozen", false],
    ["User", "Active", true],
  ] as const)(
    "renders Login for %s on %s leases: %s",
    async (role, status, expected) => {
      mockCurrentUserRoles.current = [role];
      const lease: MonitoredLeaseView = {
        ...createActiveLease({
          userEmail: testUserEmail,
          uuid: testUuid,
          status,
          awsAccountId: "123456789012",
        }),
        leaseId: testLeaseId,
      };
      mockLeaseApi.returns([lease]);
      server.use(mockLeaseApi.getHandler());

      renderComponent();

      await waitFor(() => {
        expect(screen.getByText(testUserEmail)).toBeInTheDocument();
      });

      const login = screen.queryByRole("button", { name: /^Login$/ });
      if (expected) {
        expect(login).toBeInTheDocument();
      } else {
        expect(login).not.toBeInTheDocument();
      }
    },
  );

  test("renders budget progress bar for monitored leases", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    await waitFor(() => {
      const bar = screen.getByTestId("budget-progress-bar");
      expect(bar).toBeInTheDocument();
      expect(bar).toHaveAttribute("data-current", "100");
      expect(bar).toHaveAttribute("data-max", "1000");
    });
  });

  test("displays empty state when no leases exist", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    await waitFor(() => {
      const wrapper = createWrapper();
      const table = wrapper.findTable();
      expect(table?.findEmptySlot()?.getElement()).toHaveTextContent(
        "No leases found.",
      );
    });
  });

  // ─── Selection & Bulk Actions ──────────────────────────────────────────────

  test("allows selecting and deselecting leases", async () => {
    mockLeaseApi.returns([mockActiveLease, mockPendingLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1]; // First after "select all"
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions").closest("button");
    expect(actionsButton).not.toBeDisabled();

    await user.click(checkbox);
    expect(actionsButton).toBeDisabled();
  });

  test("opens terminate modal when Terminate action is selected", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const terminateOption = await screen.findByText("Terminate");
    await user.click(terminateOption);

    const modal = screen.getByRole("dialog");
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByText("Terminate Lease(s)")).toBeInTheDocument();
  });

  test("opens freeze modal when Freeze action is selected", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const freezeOption = await screen.findByText("Freeze");
    await user.click(freezeOption);

    const modal = screen.getByRole("dialog");
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByText("Freeze Lease(s)")).toBeInTheDocument();
  });

  test("opens unfreeze modal when Unfreeze action is selected", async () => {
    mockLeaseApi.returns([mockFrozenLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockFrozenLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const unfreezeOption = await screen.findByText("Unfreeze");
    await user.click(unfreezeOption);

    const modal = screen.getByRole("dialog");
    expect(modal).toBeInTheDocument();
    expect(within(modal).getByText("Unfreeze Lease(s)")).toBeInTheDocument();
  });

  test("navigates to lease details when Update action is selected", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const updateOption = await screen.findByText("Update");
    await user.click(updateOption);

    expect(mockNavigate).toHaveBeenCalledWith(
      `/leases/${mockActiveLease.leaseId}`,
    );
  });

  // ─── Refresh ───────────────────────────────────────────────────────────────

  test("refreshes lease data when refresh button is clicked", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${getConfig().ApiUrl}/leases`, () => {
        requestCount++;
        return HttpResponse.json({
          status: "success",
          data: {
            result:
              requestCount === 1
                ? [mockActiveLease, mockPendingLease]
                : [mockActiveLease],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const refreshButton = table?.findComponent(
      'button[aria-label="Refresh"]',
      ButtonWrapper,
    );

    expect(refreshButton).not.toBeNull();
    await user.click(refreshButton!.getElement());

    await waitFor(() => {
      expect(requestCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Terminate/Freeze/Unfreeze Success & Error ─────────────────────────────

  test("successfully terminates lease and shows success status", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(
      mockLeaseApi.getHandler(),
      http.post(
        `${getConfig().ApiUrl}/leases/${mockActiveLease.leaseId}/terminate`,
        () => {
          return HttpResponse.json({
            status: "success",
            data: { message: "Lease terminated" },
          });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const terminateOption = await screen.findByText("Terminate");
    await user.click(terminateOption);

    const modal = screen.getByRole("dialog");
    const submitButton = within(modal).getByRole("button", { name: /Submit/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(within(modal).getByText("Success")).toBeInTheDocument();
    });
  });

  test("shows error status when terminate fails", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(
      mockLeaseApi.getHandler(),
      http.post(
        `${getConfig().ApiUrl}/leases/${mockActiveLease.leaseId}/terminate`,
        () => {
          return HttpResponse.json(
            { status: "fail", data: { message: "Termination failed" } },
            { status: 500 },
          );
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const terminateOption = await screen.findByText("Terminate");
    await user.click(terminateOption);

    const modal = screen.getByRole("dialog");
    const submitButton = within(modal).getByRole("button", { name: /Submit/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(within(modal).getByText("Failed")).toBeInTheDocument();
    });
  });

  test("successfully freezes lease and shows success status", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(
      mockLeaseApi.getHandler(),
      http.post(
        `${getConfig().ApiUrl}/leases/${mockActiveLease.leaseId}/freeze`,
        () => {
          return HttpResponse.json({
            status: "success",
            data: { message: "Lease frozen" },
          });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const freezeOption = await screen.findByText("Freeze");
    await user.click(freezeOption);

    const modal = screen.getByRole("dialog");
    const submitButton = within(modal).getByRole("button", { name: /Submit/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(within(modal).getByText("Success")).toBeInTheDocument();
    });
  });

  test("successfully unfreezes lease and shows success status", async () => {
    mockLeaseApi.returns([mockFrozenLease]);
    server.use(
      mockLeaseApi.getHandler(),
      http.post(
        `${getConfig().ApiUrl}/leases/${mockFrozenLease.leaseId}/unfreeze`,
        () => {
          return HttpResponse.json({
            status: "success",
            data: { message: "Lease unfrozen" },
          });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockFrozenLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const unfreezeOption = await screen.findByText("Unfreeze");
    await user.click(unfreezeOption);

    const modal = screen.getByRole("dialog");
    const submitButton = within(modal).getByRole("button", { name: /Submit/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(within(modal).getByText("Success")).toBeInTheDocument();
    });
  });

  // ─── Tab Navigation ────────────────────────────────────────────────────────

  test("switches to My Leases tab when clicked", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });

    const myLeasesTab = screen.getByRole("tab", { name: /My Leases/i });
    await user.click(myLeasesTab);

    expect(myLeasesTab).toHaveAttribute("aria-selected", "true");
  });

  test("switches to Shared with me tab when clicked", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();
    const user = userEvent.setup();

    const sharedTab = screen.getByRole("tab", { name: /Shared with me/i });
    await user.click(sharedTab);

    expect(sharedTab).toHaveAttribute("aria-selected", "true");
  });

  // ─── Shared with me Tab ────────────────────────────────────────────────────

  test("Shared with me tab shows empty state when no shared leases", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();
    const user = userEvent.setup();

    const sharedTab = screen.getByRole("tab", { name: /Shared with me/i });
    await user.click(sharedTab);

    await waitFor(() => {
      expect(screen.getByText("No shared leases found.")).toBeInTheDocument();
    });
  });

  test("Shared with me tab shows shared leases when available", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());

    const sharedLease = {
      ...mockActiveLease,
      userEmail: "sharer@example.com",
      leaseId: "shared-lease-1",
      accessType: "direct",
    };

    server.use(
      http.get(`${getConfig().ApiUrl}/leases/shared`, () => {
        return HttpResponse.json({
          status: "success",
          data: { result: [sharedLease], nextPageIdentifier: null },
        });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    const sharedTab = screen.getByRole("tab", { name: /Shared with me/i });
    await user.click(sharedTab);

    await waitFor(() => {
      expect(screen.getByText("sharer@example.com")).toBeInTheDocument();
    });
  });

  test("Shared with me tab excludes leases owned by the current user", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());

    // The direct endpoint returns owned leases too; the current user is
    // test@example.com (mockAuthenticatedUser), so their own lease must be
    // filtered out of the Shared with me tab.
    const ownedLease = {
      ...mockActiveLease,
      userEmail: "test@example.com",
      leaseId: "owned-lease-1",
      accessType: "direct",
    };
    const sharedLease = {
      ...mockActiveLease,
      userEmail: "sharer@example.com",
      leaseId: "shared-lease-1",
      accessType: "direct",
    };

    server.use(
      http.get(`${getConfig().ApiUrl}/leases/shared`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            result: [ownedLease, sharedLease],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    const sharedTab = screen.getByRole("tab", { name: /Shared with me/i });
    await user.click(sharedTab);

    await waitFor(() => {
      expect(screen.getByText("sharer@example.com")).toBeInTheDocument();
    });

    // The current user's own lease should not appear in Shared with me
    expect(screen.queryByText("test@example.com")).not.toBeInTheDocument();
  });

  // ─── Error State ───────────────────────────────────────────────────────────

  test("shows error state when lease fetch fails", async () => {
    // Override with 500 error - must be added AFTER beforeEach handlers
    server.use(
      http.get(`${getConfig().ApiUrl}/leases`, () => {
        return HttpResponse.json(
          { status: "error", message: "Internal error" },
          { status: 500 },
        );
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Failed to load all leases")).toBeInTheDocument();
    });
  });

  // ─── Access Type Badge Tests ───────────────────────────────────────────────

  test("All tab (admin) shows 'Owner' badge for current user's lease", async () => {
    // mockActiveLease has userEmail "test@example.com" matching mock user
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    await waitFor(
      () => {
        expect(screen.getByText("Owner")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  test("All tab (admin) shows 'Global' badge for non-owned lease", async () => {
    // mockPendingLease has userEmail "pending@example.com" — not the current user
    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());
    renderComponent();

    await waitFor(
      () => {
        expect(screen.getByText("Global")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  test("All tab (admin) shows 'Direct' badge for directly-shared lease", async () => {
    const sharedLease = {
      ...createActiveLease({
        userEmail: "other@example.com",
        originalLeaseTemplateName: "Shared Template",
        status: "Active",
        awsAccountId: "333333333333",
      }),
      leaseId: "shared-direct-lease-1",
      accessType: "direct",
    } as MonitoredLeaseView & { accessType: string };

    mockLeaseApi.returns([sharedLease]);
    server.use(
      mockLeaseApi.getHandler(),
      http.get(`${getConfig().ApiUrl}/leases/shared`, ({ request }) => {
        const url = new URL(request.url);
        const accessType = url.searchParams.get("accessType");
        if (accessType === "direct") {
          return HttpResponse.json({
            status: "success",
            data: { result: [sharedLease], nextPageIdentifier: null },
          });
        }
        return HttpResponse.json({
          status: "success",
          data: { result: [], nextPageIdentifier: null },
        });
      }),
    );
    renderComponent();

    await waitFor(
      () => {
        expect(screen.getByText("Direct")).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });
});
