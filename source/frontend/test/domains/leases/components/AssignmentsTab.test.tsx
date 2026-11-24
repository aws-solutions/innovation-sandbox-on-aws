// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { showErrorToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { AssignmentsTab } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentsTab";
import {
  LeaseAssignmentView,
  LeaseView,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createActiveLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";
import { GroupAssignmentMode } from "@amzn/innovation-sandbox-shared/types/configuration.js";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

const TYPEAHEAD_FIXTURE = [
  {
    principalId: "carol-id",
    principalType: "USER" as const,
    displayName: "Carol Davis",
    email: "carol@example.com",
  },
  {
    principalId: "platform-id",
    principalType: "GROUP" as const,
    displayName: "Platform",
  },
  // Same id as `userAssignment` — supports the re-add-cancels-removal test.
  {
    principalId: "user-1",
    principalType: "USER" as const,
    displayName: "Alice Smith",
    email: "alice@example.com",
  },
];
vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/components/PrincipalTypeahead",
  async () => {
    const { createPrincipalTypeaheadStub } =
      await import("@amzn/innovation-sandbox-frontend-test/utils/principalTypeaheadStub");
    return {
      PrincipalTypeahead: createPrincipalTypeaheadStub(() => TYPEAHEAD_FIXTURE),
    };
  },
);

vi.mock(
  "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService",
  async () => {
    const [{ authenticated }, { buildCognitoAuthServiceMock }] =
      await Promise.all([
        import("@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures"),
        import("@amzn/innovation-sandbox-frontend-test/utils/cognitoServiceMock"),
      ]);
    return {
      CognitoAuthService: buildCognitoAuthServiceMock({
        getCurrentUser: vi.fn().mockResolvedValue(authenticated()),
      }),
    };
  },
);

const developerPermissionSet: PermissionSetReference = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  permissionSetId: "ps-0123456789abcdef",
  name: "DeveloperAccess",
  availability: "AVAILABLE",
};
const auditorPermissionSet: PermissionSetReference = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
  permissionSetId: "ps-1123456789abcdef",
  name: "AuditorAccess",
  availability: "AVAILABLE",
};
const builtInPermissionSet: PermissionSetReference = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-2123456789abcdef",
  permissionSetId: "ps-2123456789abcdef",
  name: "BuiltInUserAccess",
  availability: "AVAILABLE",
};

const lease: LeaseView = createActiveLease({
  uuid: "11111111-1111-4111-8111-111111111111",
  userEmail: "owner@example.com",
  allowOwnerToShareLease: true,
  defaultPermissionSet: builtInPermissionSet,
  allowedPermissionSets: [builtInPermissionSet],
});
const profiledLease: LeaseView = {
  ...lease,
  defaultPermissionSet: developerPermissionSet,
  allowedPermissionSets: [developerPermissionSet, auditorPermissionSet],
};

// The API returns the reconciled view: each row already carries its
// syncStatus and isOwner, so tests set the status they want directly instead of
// arranging a desired-vs-records divergence on two endpoints.
const userAssignment: LeaseAssignmentView = {
  principalId: "user-1",
  principalType: "USER",
  displayName: "Alice Smith",
  assigneeEmail: "alice@example.com",
  addedBy: "owner-test@example.com",
  addedDate: "2026-01-01T00:00:00.000Z",
  isOwner: false,
  isDesired: true,
  syncStatus: "active",
  permissionSet: builtInPermissionSet,
};

const groupAssignment: LeaseAssignmentView = {
  principalId: "group-1",
  principalType: "GROUP",
  displayName: "Engineering",
  addedBy: "owner@example.com",
  addedDate: "2026-01-02T00:00:00.000Z",
  isOwner: false,
  isDesired: true,
  syncStatus: "active",
  permissionSet: builtInPermissionSet,
};

const ownerAssignment: LeaseAssignmentView = {
  principalId: "owner-principal-id",
  principalType: "USER",
  displayName: "Owner",
  assigneeEmail: "owner@example.com",
  addedBy: "system@example.com",
  addedDate: "2026-01-01T00:00:00.000Z",
  isOwner: true,
  isDesired: true,
  syncStatus: "active",
  permissionSet: builtInPermissionSet,
};

const assignmentsAtCapacity = (): LeaseAssignmentView[] =>
  Array.from({ length: 20 }, (_, index) => ({
    ...userAssignment,
    principalId: `user-${index + 1}`,
    displayName: `User ${index + 1}`,
    assigneeEmail: `user-${index + 1}@example.com`,
    addedBy: `admin-${index + 1}@example.com`,
    permissionSet: developerPermissionSet,
  }));

/** A row for a principal that is desired but has no access record yet. */
const desiredOnly = (
  overrides: Partial<LeaseAssignmentView> & { principalId: string },
): LeaseAssignmentView => {
  const {
    permissionSet = builtInPermissionSet,
    syncStatus = "grantFailed",
    ...rest
  } = overrides;
  return {
    principalType: "USER",
    displayName: "Carol Davis",
    assigneeEmail: "carol@example.com",
    isOwner: false,
    isDesired: true,
    syncStatus,
    ...rest,
    permissionSet,
  };
};

/** A record that lingers after a failed revoke: present, but no longer desired. */
const lingeringRecord = (
  overrides: Partial<LeaseAssignmentView> & { principalId: string },
): LeaseAssignmentView => {
  const {
    permissionSet = builtInPermissionSet,
    syncStatus = "revokeFailed",
    ...rest
  } = overrides;
  return {
    principalType: "USER",
    displayName: "Dave Lingering",
    assigneeEmail: "dave@example.com",
    addedBy: "admin@example.com",
    addedDate: "2026-01-01T00:00:00.000Z",
    isOwner: false,
    isDesired: false,
    syncStatus,
    ...rest,
    permissionSet,
  };
};

const LEASE_ROUTE_ID = "lease-route-id-base64";

function stubGetAssignments(
  items: LeaseAssignmentView[],
  operationInProgress?: "FREEZE" | "UNFREEZE" | "TERMINATE" | "UPDATE",
) {
  server.use(
    http.get(`${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`, () =>
      HttpResponse.json({
        status: "success",
        data: { assignments: items, operationInProgress },
      }),
    ),
  );
}

function stubGetLeaseById(
  overrides: Partial<{
    desiredAssignments:
      | {
          principalId: string;
          principalType: "USER" | "GROUP";
          displayName?: string;
          email?: string;
        }[]
      | undefined;
    resourceLock: {
      ownerId: string;
      acquiredAt: string;
      expiresAt: string;
      // The intent drives the direction rows are labelled with (a missing
      // record is a pending grant during UPDATE/UNFREEZE but already revoked
      // during FREEZE/TERMINATE).
      meta?: {
        intent: "FREEZE" | "UNFREEZE" | "TERMINATE" | "UPDATE" | "PUBLISH";
      };
    } | null;
  }> = {},
) {
  const desiredAssignments =
    "desiredAssignments" in overrides
      ? overrides.desiredAssignments
      : [
          {
            principalId: "owner-principal-id",
            principalType: "USER" as const,
            displayName: "Owner",
            email: "owner@example.com",
          },
          {
            principalId: "user-1",
            principalType: "USER" as const,
            displayName: "Alice Smith",
            email: "alice@example.com",
          },
          {
            principalId: "group-1",
            principalType: "GROUP" as const,
            displayName: "Engineering",
          },
        ];
  server.use(
    http.get(`${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}`, () =>
      HttpResponse.json({
        status: "success",
        data: {
          ...lease,
          desiredAssignments,
          resourceLock: overrides.resourceLock ?? null,
        },
      }),
    ),
  );
}

function renderTab(
  props: Partial<React.ComponentProps<typeof AssignmentsTab>> = {},
) {
  const Wrapper = createQueryClientWrapper();
  return render(
    <MemoryRouter>
      <Wrapper>
        <AssignmentsTab
          lease={lease}
          leaseRouteId={LEASE_ROUTE_ID}
          leaseSharingEnabled={true}
          enablePrincipalSearch={true}
          isElevated={false}
          isOwner={true}
          {...props}
        />
      </Wrapper>
    </MemoryRouter>,
  );
}

async function togglePermissionSet(
  displayName: string,
  permissionSetArn: string,
) {
  const labels = await screen.findAllByText(displayName);
  const principalRow = labels
    .map((label) => label.closest("tr"))
    .find((row) => row && createWrapper(row).findSelect());
  expect(principalRow).toBeTruthy();
  const select = createWrapper(principalRow!).findSelect()!;
  if (
    select.findTrigger().getElement().getAttribute("aria-expanded") !== "true"
  ) {
    select.openDropdown();
  }
  select.selectOptionByValue(permissionSetArn, {
    expandToViewport: true,
  });
}

describe("AssignmentsTab", () => {
  beforeEach(() => {
    stubGetLeaseById();
  });

  it("renders existing assignments from the API", async () => {
    stubGetAssignments([userAssignment, groupAssignment]);
    renderTab();

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Engineering")).toBeInTheDocument();
  });

  it("replaces the permission set selected for a principal", async () => {
    stubGetAssignments([
      { ...userAssignment, permissionSet: developerPermissionSet },
    ]);
    let putBody: unknown;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = await request.json();
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 1 } },
            { status: 202 },
          );
        },
      ),
    );
    renderTab({ lease: profiledLease });
    const user = userEvent.setup();

    await togglePermissionSet(
      "Alice Smith",
      auditorPermissionSet.permissionSetArn,
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody).toEqual({
      assignments: [
        {
          principalId: "user-1",
          principalType: "USER",
          permissionSetArn: auditorPermissionSet.permissionSetArn,
        },
      ],
    });
  });

  it("selects one permission set for a newly added principal", async () => {
    stubGetAssignments([
      { ...ownerAssignment, permissionSet: developerPermissionSet },
    ]);
    let putBody: unknown;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = await request.json();
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 2 } },
            { status: 202 },
          );
        },
      ),
    );
    renderTab({ lease: profiledLease });
    const user = userEvent.setup();

    expect((await screen.findAllByText("Owner")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Add carol-id" }));
    expect(
      screen.queryByRole("button", { name: "Add carol-id" }),
    ).not.toBeInTheDocument();
    await togglePermissionSet(
      "Carol Davis",
      auditorPermissionSet.permissionSetArn,
    );

    expect(screen.getAllByText("Carol Davis")).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: /Permission set for Carol Davis/,
      }),
    ).toHaveTextContent("AuditorAccess");
    expect(
      screen.queryByRole("button", { name: "Add carol-id" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody).toEqual({
      assignments: [
        {
          principalId: "owner-principal-id",
          principalType: "USER",
          permissionSetArn: developerPermissionSet.permissionSetArn,
        },
        {
          principalId: "carol-id",
          principalType: "USER",
          permissionSetArn: auditorPermissionSet.permissionSetArn,
        },
      ],
    });
  });

  it("removes all access for a principal", async () => {
    stubGetAssignments([
      { ...ownerAssignment, permissionSet: developerPermissionSet },
      { ...userAssignment, permissionSet: developerPermissionSet },
    ]);
    let putBody: unknown;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = await request.json();
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 1 } },
            { status: 202 },
          );
        },
      ),
    );
    renderTab({ lease: profiledLease });
    const user = userEvent.setup();

    const aliceRow = (await screen.findByText("Alice Smith")).closest("tr")!;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );

    expect(within(aliceRow).getByText("Pending remove")).toBeInTheDocument();
    expect(
      within(aliceRow).queryByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody).toEqual({
      assignments: [
        {
          principalId: "owner-principal-id",
          principalType: "USER",
          permissionSetArn: developerPermissionSet.permissionSetArn,
        },
      ],
    });
  });

  it("keeps USER and GROUP rows distinct when their principal IDs collide", async () => {
    stubGetAssignments([
      {
        ...userAssignment,
        principalId: "shared-id",
        displayName: "Shared User",
        permissionSet: developerPermissionSet,
      },
      {
        ...groupAssignment,
        principalId: "shared-id",
        displayName: "Shared Group",
        permissionSet: developerPermissionSet,
      },
    ]);
    renderTab({ lease: profiledLease, isOwner: false });

    expect(await screen.findByText("Shared User")).toBeInTheDocument();
    expect(screen.getByText("Shared Group")).toBeInTheDocument();
  });

  it("renders the hydrated built-in permission set", async () => {
    stubGetAssignments([userAssignment]);
    renderTab({ lease: profiledLease, isOwner: false });

    expect(await screen.findByText("BuiltInUserAccess")).toBeInTheDocument();
  });

  it("keeps existing groups visible but searches only users when groups are disabled", async () => {
    stubGetAssignments([ownerAssignment, groupAssignment]);
    renderTab({ groupAssignmentMode: GroupAssignmentMode.NONE });

    expect(await screen.findByText("Engineering")).toBeInTheDocument();
    expect(screen.getByTestId("typeahead-stub")).toHaveAttribute(
      "data-search-type",
      "users",
    );
    expect(
      screen.queryByRole("button", { name: "Add platform-id" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove access for Engineering" }),
    ).toBeInTheDocument();
  });

  it("changes an existing group's permission set when group search is disabled", async () => {
    stubGetAssignments([
      { ...ownerAssignment, permissionSet: developerPermissionSet },
      { ...groupAssignment, permissionSet: developerPermissionSet },
    ]);
    let putBody: unknown;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = await request.json();
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 2 } },
            { status: 202 },
          );
        },
      ),
    );
    renderTab({
      lease: profiledLease,
      groupAssignmentMode: GroupAssignmentMode.NONE,
    });
    const user = userEvent.setup();

    await togglePermissionSet(
      "Engineering",
      auditorPermissionSet.permissionSetArn,
    );

    expect(screen.getAllByText("Engineering")).toHaveLength(1);
    expect(
      screen.getByRole("button", {
        name: /Permission set for Engineering/,
      }),
    ).toHaveTextContent("AuditorAccess");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody).toEqual({
      assignments: [
        {
          principalId: "owner-principal-id",
          principalType: "USER",
          permissionSetArn: developerPermissionSet.permissionSetArn,
        },
        {
          principalId: "group-1",
          principalType: "GROUP",
          permissionSetArn: auditorPermissionSet.permissionSetArn,
        },
      ],
    });
  });

  it("always shows the owner row even when no other assignments exist", async () => {
    stubGetAssignments([ownerAssignment]);
    renderTab();

    // The owner row is always present from the assignment record.
    const ownerCells = await screen.findAllByText("owner@example.com");
    expect(ownerCells.length).toBeGreaterThan(0);
  });

  it("hides add controls and Save button when the viewer cannot manage", async () => {
    stubGetAssignments([userAssignment]);
    // A non-owner, non-elevated viewer (e.g., another shared user) sees
    // read-only.
    renderTab({ isOwner: false, isElevated: false });

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);
    // The "Configure access" Container holds the always-visible typeahead and
    // is rendered only when the viewer can manage assignments.
    expect(screen.queryByText("Configure access")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save changes" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Remove access for/ }),
    ).not.toBeInTheDocument();
  });

  it("hides add controls for owner when allowOwnerToShareLease is false", async () => {
    stubGetAssignments([userAssignment]);
    const restrictedLease: LeaseView = {
      ...lease,
      allowOwnerToShareLease: false,
    };
    renderTab({ lease: restrictedLease, isOwner: true });

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);
    // The "Configure access" Container holds the always-visible typeahead and
    // is rendered only when the viewer can manage assignments.
    expect(screen.queryByText("Configure access")).not.toBeInTheDocument();
  });

  it("shows the global-flag-off banner only for elevated viewers", async () => {
    stubGetAssignments([userAssignment]);
    renderTab({ leaseSharingEnabled: false, isElevated: true });

    expect(
      await screen.findByText(/Lease sharing is disabled globally/i),
    ).toBeInTheDocument();
  });

  it("stages a removal and submits the diff on Save", async () => {
    stubGetAssignments([ownerAssignment, userAssignment, groupAssignment]);

    let putBody: unknown;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = await request.json();
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 1 } },
            { status: 202 },
          );
        },
      ),
    );

    renderTab();
    const user = userEvent.setup();

    // Wait for the rows to render.
    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    // Click Remove on alice's row.
    // Scope to alice's row via the unique addedBy cell to avoid the
    // duplicate-email match in the Name + Email columns.
    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );

    // The "Pending remove" badge should appear and Save should be enabled.
    expect(screen.getByText("Pending remove")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).not.toBeDisabled();

    await user.click(save);

    await waitFor(() => expect(putBody).toBeDefined());
    // The owner and group remain in the desired list — alice was removed.
    expect(putBody).toEqual({
      assignments: [
        {
          principalId: "owner-principal-id",
          principalType: "USER",
          permissionSetArn: builtInPermissionSet.permissionSetArn,
        },
        {
          principalId: "group-1",
          principalType: "GROUP",
          permissionSetArn: builtInPermissionSet.permissionSetArn,
        },
      ],
    });
  });

  it("locks editing and prevents duplicate saves during the preflight refresh", async () => {
    let getCalls = 0;
    let putCalls = 0;
    let releasePreflight!: () => void;
    let markPreflightStarted!: () => void;
    const preflightGate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const preflightStarted = new Promise<void>((resolve) => {
      markPreflightStarted = resolve;
    });
    server.use(
      http.get(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async () => {
          getCalls += 1;
          if (getCalls === 2) {
            markPreflightStarted();
            await preflightGate;
          }
          return HttpResponse.json({
            status: "success",
            data: { assignments: [ownerAssignment, userAssignment] },
          });
        },
      ),
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => {
          putCalls += 1;
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 1 } },
            { status: 202 },
          );
        },
      ),
    );
    renderTab();
    const user = userEvent.setup();

    const aliceRow = (
      await screen.findByText("owner-test@example.com")
    ).closest("tr")!;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );
    const save = screen.getByRole("button", { name: "Save changes" });

    fireEvent.click(save);
    fireEvent.click(save);
    await preflightStarted;

    await waitFor(() => {
      expect(save).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Add carol-id" }),
      ).toBeDisabled();
      expect(
        within(aliceRow).getByRole("button", {
          name: "Undo access removal for Alice Smith",
        }),
      ).toBeDisabled();
    });
    expect(getCalls).toBe(2);

    releasePreflight();
    await waitFor(() => expect(putCalls).toBe(1));
  });

  it("performs one authoritative refresh after saving", async () => {
    let getCalls = 0;
    let assignmentsSaved = false;
    server.use(
      http.get(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => {
          getCalls += 1;
          return HttpResponse.json({
            status: "success",
            data: {
              assignments: assignmentsSaved
                ? [ownerAssignment]
                : [ownerAssignment, userAssignment],
            },
          });
        },
      ),
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => {
          assignmentsSaved = true;
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 1 } },
            { status: 202 },
          );
        },
      ),
    );
    renderTab();
    const user = userEvent.setup();

    const aliceRow = (
      await screen.findByText("owner-test@example.com")
    ).closest("tr")!;
    const initialGetCalls = getCalls;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(screen.queryByText("Alice Smith")).not.toBeInTheDocument(),
    );
    expect(getCalls).toBe(initialGetCalls + 2);
    expect(
      screen.queryByText("Assignments changed elsewhere"),
    ).not.toBeInTheDocument();
  });

  it("does not save when the preflight refresh discovers an active update", async () => {
    let getCalls = 0;
    let putCalls = 0;
    server.use(
      http.get(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => {
          getCalls += 1;
          return HttpResponse.json({
            status: "success",
            data: {
              assignments: [ownerAssignment, userAssignment],
              operationInProgress: getCalls > 1 ? "UPDATE" : undefined,
            },
          });
        },
      ),
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => {
          putCalls += 1;
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 1 } },
            { status: 202 },
          );
        },
      ),
    );
    renderTab();
    const user = userEvent.setup();

    const aliceRow = (
      await screen.findByText("owner-test@example.com")
    ).closest("tr")!;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(
        "An update is being processed. Saving more changes is paused until it completes.",
      ),
    ).toBeInTheDocument();
    expect(putCalls).toBe(0);
    expect(screen.getByText("Pending remove")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("refreshes into the active operation when the update loses the lock race", async () => {
    let lockActive = false;
    let putCalls = 0;
    server.use(
      http.get(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () =>
          HttpResponse.json({
            status: "success",
            data: {
              assignments: [ownerAssignment, userAssignment],
              operationInProgress: lockActive ? "UPDATE" : undefined,
            },
          }),
      ),
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => {
          putCalls += 1;
          lockActive = true;
          return HttpResponse.json(
            { status: "error", message: "lock held" },
            { status: 409 },
          );
        },
      ),
    );
    renderTab();
    const user = userEvent.setup();

    const aliceRow = (
      await screen.findByText("owner-test@example.com")
    ).closest("tr")!;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(
        "An update is being processed. Saving more changes is paused until it completes.",
      ),
    ).toBeInTheDocument();
    expect(putCalls).toBe(1);
    expect(screen.getByText("Pending remove")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("preserves the owner's explicit permission set when saving another change", async () => {
    stubGetAssignments([
      { ...ownerAssignment, permissionSet: auditorPermissionSet },
      { ...userAssignment, permissionSet: developerPermissionSet },
    ]);
    let putBody: unknown;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = await request.json();
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 1 } },
            { status: 202 },
          );
        },
      ),
    );
    renderTab({ lease: profiledLease });
    const user = userEvent.setup();

    const aliceRow = (await screen.findByText("Alice Smith")).closest("tr")!;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody).toEqual({
      assignments: [
        {
          principalId: "owner-principal-id",
          principalType: "USER",
          permissionSetArn: auditorPermissionSet.permissionSetArn,
        },
      ],
    });
  });

  it("allows the owner permission set to be changed without allowing removal", async () => {
    stubGetAssignments([
      { ...ownerAssignment, permissionSet: developerPermissionSet },
    ]);
    let putBody: unknown;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = await request.json();
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 1 } },
            { status: 202 },
          );
        },
      ),
    );
    renderTab({ lease: profiledLease });
    const user = userEvent.setup();

    const ownerPermissionSets = await screen.findByRole("button", {
      name: /Permission set for Owner/,
    });
    const ownerRow = ownerPermissionSets.closest("tr")!;
    expect(
      within(ownerRow).queryByRole("button", {
        name: "Remove access for Owner",
      }),
    ).not.toBeInTheDocument();

    await togglePermissionSet("Owner", auditorPermissionSet.permissionSetArn);

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody).toEqual({
      assignments: [
        {
          principalId: "owner-principal-id",
          principalType: "USER",
          permissionSetArn: auditorPermissionSet.permissionSetArn,
        },
      ],
    });
  });

  it("allows an owner permission-set change to be undone", async () => {
    stubGetAssignments([
      { ...ownerAssignment, permissionSet: developerPermissionSet },
    ]);
    renderTab({ lease: profiledLease });
    const user = userEvent.setup();

    await togglePermissionSet("Owner", auditorPermissionSet.permissionSetArn);

    const ownerRow = screen
      .getByRole("button", { name: /Permission set for Owner/ })
      .closest("tr")!;
    expect(
      within(ownerRow).queryByRole("button", {
        name: "Remove access for Owner",
      }),
    ).not.toBeInTheDocument();

    await user.click(
      within(ownerRow).getByRole("button", {
        name: "Undo permission set change for Owner",
      }),
    );

    expect(screen.queryByText("Pending change")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("disables Save when there are no staged changes", async () => {
    stubGetAssignments([userAssignment]);
    renderTab();

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("discards staged changes when the user clicks Discard", async () => {
    stubGetAssignments([userAssignment, groupAssignment]);
    renderTab();
    const user = userEvent.setup();

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    // Scope to alice's row via the unique addedBy cell to avoid the
    // duplicate-email match in the Name + Email columns.
    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );
    expect(screen.getByText("Pending remove")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByText("Pending remove")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("hides Remove and shows the Owner badge on the lease owner's row", async () => {
    const ownerAssignment: LeaseAssignmentView = {
      principalId: "owner-id",
      principalType: "USER",
      displayName: "Lease Owner",
      assigneeEmail: lease.userEmail,
      // addedBy is distinct so the row can be located unambiguously. Ownership
      // is now reported by the API rather than inferred from the email.
      addedBy: "admin@example.com",
      addedDate: "2026-01-01T00:00:00.000Z",
      isOwner: true,
      isDesired: true,
      syncStatus: "active",
      permissionSet: builtInPermissionSet,
    };
    stubGetAssignments([ownerAssignment, userAssignment]);
    renderTab();

    // Wait for both rows to load.
    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    // Owner row located via the unique addedBy cell.
    const ownerRow = screen.getByText("admin@example.com").closest("tr")!;
    expect(within(ownerRow).getByText("Owner")).toBeInTheDocument();
    expect(
      within(ownerRow).queryByRole("button", {
        name: "Remove access for Lease Owner",
      }),
    ).not.toBeInTheDocument();

    // Non-owner row still has Remove (sanity check that the suppression is
    // owner-specific, not blanket).
    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    expect(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    ).toBeInTheDocument();
  });

  it("stages a typeahead pick and submits it in the PUT body", async () => {
    stubGetAssignments([ownerAssignment, userAssignment]);
    stubGetLeaseById({
      desiredAssignments: [
        {
          principalId: "owner-principal-id",
          principalType: "USER",
          displayName: "Owner",
          email: "owner@example.com",
        },
        {
          principalId: "user-1",
          principalType: "USER",
          displayName: "Alice Smith",
          email: "alice@example.com",
        },
      ],
    });

    let putBody: unknown;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = await request.json();
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 2 } },
            { status: 202 },
          );
        },
      ),
    );

    renderTab();
    const user = userEvent.setup();

    // Wait for the existing row before driving the typeahead stub.
    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Add carol-id" }));
    expect(screen.getByText("Pending add")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody).toEqual({
      assignments: [
        {
          principalId: "owner-principal-id",
          principalType: "USER",
          permissionSetArn: builtInPermissionSet.permissionSetArn,
        },
        {
          principalId: "user-1",
          principalType: "USER",
          permissionSetArn: builtInPermissionSet.permissionSetArn,
        },
        {
          principalId: "carol-id",
          principalType: "USER",
          permissionSetArn: builtInPermissionSet.permissionSetArn,
        },
      ],
    });
  });

  it("undoes a staged removal without re-adding the principal", async () => {
    stubGetAssignments([
      {
        ...userAssignment,
        permissionSet: developerPermissionSet,
      },
    ]);
    renderTab({ lease: profiledLease });
    const user = userEvent.setup();

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );
    expect(screen.getByText("Pending remove")).toBeInTheDocument();

    expect(
      screen.queryByRole("button", { name: "Add user-1" }),
    ).not.toBeInTheDocument();
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Undo access removal for Alice Smith",
      }),
    );
    expect(screen.queryByText("Pending remove")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending add")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("clears a staged replacement when the original permission set is restored", async () => {
    stubGetAssignments([
      {
        ...userAssignment,
        permissionSet: developerPermissionSet,
      },
    ]);
    renderTab({ lease: profiledLease });
    await togglePermissionSet(
      "Alice Smith",
      auditorPermissionSet.permissionSetArn,
    );
    await togglePermissionSet(
      "Alice Smith",
      developerPermissionSet.permissionSetArn,
    );

    expect(screen.queryByText("Pending change")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Changing from DeveloperAccess"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("offers an explicit undo for a staged permission-set replacement", async () => {
    stubGetAssignments([
      {
        ...userAssignment,
        permissionSet: developerPermissionSet,
      },
    ]);
    renderTab({ lease: profiledLease });
    const user = userEvent.setup();

    await togglePermissionSet(
      "Alice Smith",
      auditorPermissionSet.permissionSetArn,
    );

    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    await user.click(
      screen.getByRole("button", {
        name: "Show permission set operations for Alice Smith",
      }),
    );
    expect(screen.getByText("Grant access")).toBeInTheDocument();
    expect(screen.getByText("Revoke access")).toBeInTheDocument();
    expect(screen.getAllByText("Pending save")).toHaveLength(2);

    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Undo permission set change for Alice Smith",
      }),
    );

    expect(screen.queryByText("Pending change")).not.toBeInTheDocument();
    expect(screen.queryByText("Grant access")).not.toBeInTheDocument();
    expect(screen.queryByText("Revoke access")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("allows a count-neutral permission-set replacement at capacity", async () => {
    stubGetAssignments(assignmentsAtCapacity());
    renderTab({ lease: profiledLease });

    await togglePermissionSet("User 1", auditorPermissionSet.permissionSetArn);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await togglePermissionSet(
      "User 1",
      developerPermissionSet.permissionSetArn,
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("preserves staged edits across background query refreshes", async () => {
    stubGetAssignments([ownerAssignment, userAssignment]);
    renderTab();
    const user = userEvent.setup();

    const aliceRow = (
      await screen.findByText("owner-test@example.com")
    ).closest("tr")!;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );
    expect(screen.getByText("Pending remove")).toBeInTheDocument();

    stubGetAssignments([
      ownerAssignment,
      desiredOnly({
        principalId: "server-only-user",
        displayName: "Server-only user",
      }),
    ]);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(screen.getByText("Pending remove")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Server-only user")).not.toBeInTheDocument();
    expect(
      screen.getByText("Assignments changed elsewhere"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add carol-id" })).toBeDisabled();
    expect(
      within(aliceRow).getByRole("button", {
        name: "Undo access removal for Alice Smith",
      }),
    ).toBeDisabled();
  });

  it("reports a refresh failure separately after assignments are saved", async () => {
    let assignmentsSaved = false;
    let refreshShouldFail = true;
    server.use(
      http.get(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => {
          if (!assignmentsSaved) {
            return HttpResponse.json({
              status: "success",
              data: { assignments: [ownerAssignment, userAssignment] },
            });
          }
          return refreshShouldFail
            ? HttpResponse.json(
                { status: "error", message: "Refresh failed" },
                { status: 500 },
              )
            : HttpResponse.json({
                status: "success",
                data: { assignments: [ownerAssignment] },
              });
        },
      ),
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => {
          assignmentsSaved = true;
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 1 } },
            { status: 202 },
          );
        },
      ),
    );
    renderTab();
    const user = userEvent.setup();

    const aliceRow = (await screen.findByText("alice@example.com")).closest(
      "tr",
    )!;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(showErrorToast).toHaveBeenCalledWith(
        "Assignments were saved, but the latest status could not be loaded. Refresh the page to see the current state.",
        "Status refresh failed",
      ),
    );
    expect(
      await screen.findByText("Assignments may be out of date"),
    ).toBeInTheDocument();
    expect(screen.getByText("Alice Smith")).toBeInTheDocument();
    expect(screen.getByText("Pending remove")).toBeInTheDocument();
    expect(
      screen.queryByText(
        /There was a problem loading assignments for this lease/i,
      ),
    ).not.toBeInTheDocument();

    refreshShouldFail = false;
    await user.click(screen.getByRole("button", { name: "Retry refresh" }));

    await waitFor(() => {
      expect(
        screen.queryByText("Assignments may be out of date"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Alice Smith")).not.toBeInTheDocument();
    });
    expect(
      screen.queryByText("Assignments changed elsewhere"),
    ).not.toBeInTheDocument();
  });

  it("renders the transitional statuses reported by the API", async () => {
    stubGetAssignments(
      [
        { ...userAssignment, syncStatus: "revoking" },
        groupAssignment,
        desiredOnly({ principalId: "carol-id", syncStatus: "granting" }),
      ],
      "UPDATE",
    );
    renderTab();

    const aliceRow = (
      await screen.findByText("owner-test@example.com")
    ).closest("tr")!;
    expect(within(aliceRow).getByText("Revoking")).toBeInTheDocument();

    const groupRow = screen.getByText("Engineering").closest("tr")!;
    expect(within(groupRow).getByText("Active")).toBeInTheDocument();

    expect(await screen.findByText("Granting")).toBeInTheDocument();
  });

  it("polls assignment status while an operation is in progress", async () => {
    let getCalls = 0;
    server.use(
      http.get(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => {
          getCalls++;
          return HttpResponse.json({
            status: "success",
            data: {
              assignments: [userAssignment],
              operationInProgress: getCalls === 1 ? "UPDATE" : undefined,
            },
          });
        },
      ),
    );
    let poll: (() => unknown) | undefined;
    const originalSetInterval = globalThis.setInterval;
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 5_000) {
          poll = callback as () => unknown;
          return 1 as unknown as ReturnType<typeof setInterval>;
        }
        return originalSetInterval(callback, delay, ...args);
      });

    const view = renderTab();
    try {
      expect(
        await screen.findByText(
          "An update is being processed. Saving more changes is paused until it completes.",
        ),
      ).toBeInTheDocument();
      expect(poll).toBeDefined();

      await act(async () => {
        await poll?.();
      });

      await waitFor(() => expect(getCalls).toBe(2));
      await waitFor(() =>
        expect(
          screen.queryByText(
            "An update is being processed. Saving more changes is paused until it completes.",
          ),
        ).not.toBeInTheDocument(),
      );
    } finally {
      view.unmount();
      setIntervalSpy.mockRestore();
    }
  });

  it("renders the failure statuses reported by the API", async () => {
    // The API decides these; the client only projects them. It no longer infers
    // failure from a divergence between two independently-fetched endpoints.
    stubGetAssignments([
      { ...userAssignment, syncStatus: "revokeFailed" },
      desiredOnly({ principalId: "carol-id", syncStatus: "grantFailed" }),
    ]);
    renderTab();

    const aliceRow = (
      await screen.findByText("owner-test@example.com")
    ).closest("tr")!;
    expect(within(aliceRow).getByText("Revoke failed")).toBeInTheDocument();
    expect(await screen.findByText("Grant failed")).toBeInTheDocument();
  });

  it("expands mixed grant and revoke outcomes for a permission-set replacement", async () => {
    stubGetAssignments([
      {
        ...userAssignment,
        syncStatus: "active",
        permissionSet: auditorPermissionSet,
      },
      {
        ...userAssignment,
        isDesired: false,
        syncStatus: "revokeFailed",
        permissionSet: developerPermissionSet,
      },
    ]);
    renderTab({ lease: profiledLease });
    const user = userEvent.setup();

    expect(screen.queryByText("Grant access")).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Expand all" }));

    const grantRow = screen.getByText("Grant access").closest("tr")!;
    expect(within(grantRow).getByText("AuditorAccess")).toBeInTheDocument();
    expect(within(grantRow).getByText("Active")).toBeInTheDocument();

    const revokeRow = screen.getByText("Revoke access").closest("tr")!;
    expect(within(revokeRow).getByText("DeveloperAccess")).toBeInTheDocument();
    expect(within(revokeRow).getByText("Revoke failed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByText("Grant access")).not.toBeInTheDocument();
    expect(screen.queryByText("Revoke access")).not.toBeInTheDocument();
  });

  describe("frozen lease", () => {
    const frozenLease: LeaseView = { ...lease, status: "Frozen" };

    it("shows suspended principals without calling them failures", async () => {
      // A freeze revokes the records but retains the desired set, so the API
      // reports this steady state as suspended rather than a failed grant.
      stubGetAssignments([
        desiredOnly({ principalId: "carol-id", syncStatus: "suspended" }),
      ]);
      renderTab({ lease: frozenLease });

      expect(await screen.findByText("Access suspended")).toBeInTheDocument();
      expect(screen.queryByText("Grant failed")).not.toBeInTheDocument();
    });

    it("renders read-only and explains why, since the API rejects edits", async () => {
      // putLeaseAssignmentsHandler returns 409 "Lease is not in an active
      // status", so the editing controls must be gated on status, not just role.
      stubGetAssignments([userAssignment]);
      renderTab({ lease: frozenLease, isElevated: true });

      expect(
        await screen.findByText(/This lease is frozen, so account access/),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Save changes" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Remove access for/ }),
      ).not.toBeInTheDocument();
    });

    it("names a freeze in progress and shows no pending grants", async () => {
      stubGetAssignments(
        [
          { ...userAssignment, syncStatus: "revoking" },
          desiredOnly({ principalId: "carol-id", syncStatus: "suspended" }),
        ],
        "FREEZE",
      );
      renderTab({ lease: frozenLease, isElevated: true });

      expect(
        await screen.findByText(/Freezing this lease/),
      ).toBeInTheDocument();
      expect(await screen.findByText("Revoking")).toBeInTheDocument();
      expect(screen.queryByText("Granting")).not.toBeInTheDocument();
      expect(screen.queryByText("Grant failed")).not.toBeInTheDocument();
    });

    it("does not offer Retry while frozen", async () => {
      // Retrying would PUT and get a 409.
      stubGetAssignments([
        desiredOnly({ principalId: "carol-id", syncStatus: "suspended" }),
      ]);
      renderTab({ lease: frozenLease, isElevated: true });

      expect(await screen.findByText("Access suspended")).toBeInTheDocument();
      expect(
        screen.queryByText("Some access changes did not apply"),
      ).not.toBeInTheDocument();
    });
  });

  describe("terminated lease", () => {
    // The tab stays available on a terminal lease so an operator can answer
    // "who had access to this account", but nothing about it is editable.
    const terminatedLease: LeaseView = {
      ...lease,
      status: "ManuallyTerminated",
    } as LeaseView;

    it("lists who had access, read-only", async () => {
      stubGetAssignments([
        desiredOnly({ principalId: "carol-id", syncStatus: "suspended" }),
      ]);
      renderTab({ lease: terminatedLease, isElevated: true });

      expect(await screen.findByText("Carol Davis")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Save changes" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Remove access for/ }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Configure access")).not.toBeInTheDocument();
    });

    it("says access ended rather than suspended", async () => {
      // Same server status as a frozen lease, but a termination cannot be undone.
      stubGetAssignments([
        desiredOnly({ principalId: "carol-id", syncStatus: "suspended" }),
      ]);
      renderTab({ lease: terminatedLease, isElevated: true });

      expect(await screen.findByText("Access ended")).toBeInTheDocument();
      expect(screen.queryByText("Access suspended")).not.toBeInTheDocument();
      expect(
        screen.getByText(/list is kept as a record of who had access/),
      ).toBeInTheDocument();
    });

    it("still surfaces a failed revoke, since that is orphaned access", async () => {
      // A record surviving on a terminated lease means the principal may still
      // reach the account. Hiding it would defeat the point of the audit view.
      stubGetAssignments([lingeringRecord({ principalId: "dave-id" })]);
      renderTab({ lease: terminatedLease, isElevated: true });

      expect(await screen.findByText("Revoke failed")).toBeInTheDocument();
    });

    it("does not offer Retry", async () => {
      // Retry would PUT and get a 409 — the lease is not active.
      stubGetAssignments([lingeringRecord({ principalId: "dave-id" })]);
      renderTab({ lease: terminatedLease, isElevated: true });

      expect(await screen.findByText("Revoke failed")).toBeInTheDocument();
      expect(
        screen.queryByText("Some access changes did not apply"),
      ).not.toBeInTheDocument();
    });
  });

  it("names an unfreeze in progress without reporting failures", async () => {
    // Mid-unfreeze the records are not restored yet. Because the status and the
    // operation arrive on one response, this can never read as a failed grant.
    stubGetAssignments(
      [desiredOnly({ principalId: "carol-id", syncStatus: "granting" })],
      "UNFREEZE",
    );
    renderTab();

    expect(
      await screen.findByText(/Unfreezing this lease/),
    ).toBeInTheDocument();
    expect(screen.getByText("Granting")).toBeInTheDocument();
    expect(screen.queryByText("Grant failed")).not.toBeInTheDocument();
  });

  it("excludes a pending revoke from the submitted desired set", async () => {
    // Regression: every non-removed row used to be echoed back as desired, so
    // retrying a failed revoke re-desired the principal and cancelled the
    // revoke — repairing the desired state to match reality instead of applying
    // it. The API marks such rows isDesired: false and they must be dropped.
    stubGetAssignments([
      userAssignment,
      lingeringRecord({ principalId: "dave-id" }),
    ]);

    let putBody: { assignments: { principalId: string }[] } | undefined;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = (await request.json()) as typeof putBody;
          return HttpResponse.json(
            { status: "success", data: { desiredCount: 1 } },
            { status: 202 },
          );
        },
      ),
    );

    renderTab();
    const user = userEvent.setup();

    expect(await screen.findByText("Revoke failed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(putBody).toBeDefined());
    const submitted = putBody!.assignments.map((a) => a.principalId);
    expect(submitted).toContain("user-1");
    expect(submitted).not.toContain("dave-id");
  });

  describe("pending revoke", () => {
    it("offers Undo instead of Remove, leaving other rows editable", async () => {
      // Removal is what's already pending, so Remove is meaningless. The revoke
      // may itself be the mistake, so the row offers to undo it.
      stubGetAssignments([
        userAssignment,
        lingeringRecord({ principalId: "dave-id" }),
      ]);
      renderTab();

      const daveRow = (await screen.findByText("dave@example.com")).closest(
        "tr",
      )!;
      expect(
        within(daveRow).getByRole("button", {
          name: "Undo access removal for Dave Lingering",
        }),
      ).toBeInTheDocument();
      expect(
        within(daveRow).queryByRole("button", {
          name: "Remove access for Dave Lingering",
        }),
      ).not.toBeInTheDocument();

      const aliceRow = screen
        .getByText("owner-test@example.com")
        .closest("tr")!;
      expect(
        within(aliceRow).getByRole("button", {
          name: "Remove access for Alice Smith",
        }),
      ).not.toBeDisabled();
    });

    it("disables Undo when restoring access would exceed capacity", async () => {
      stubGetAssignments([
        ...assignmentsAtCapacity(),
        lingeringRecord({ principalId: "dave-id" }),
      ]);
      renderTab();

      const daveRow = (await screen.findByText("dave@example.com")).closest(
        "tr",
      )!;
      expect(
        within(daveRow).getByRole("button", {
          name: "Undo access removal for Dave Lingering",
        }),
      ).toBeDisabled();
    });

    it("stages the undo and submits the principal as desired", async () => {
      // The access record still exists, so the backend resolves this to a NO_OP
      // and the row settles back to active — nothing is re-granted.
      stubGetAssignments([
        userAssignment,
        lingeringRecord({ principalId: "dave-id" }),
      ]);

      let putBody: { assignments: { principalId: string }[] } | undefined;
      server.use(
        http.put(
          `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
          async ({ request }) => {
            putBody = (await request.json()) as typeof putBody;
            return HttpResponse.json(
              { status: "success", data: { desiredCount: 2 } },
              { status: 202 },
            );
          },
        ),
      );

      renderTab();
      const user = userEvent.setup();

      const daveRow = (await screen.findByText("dave@example.com")).closest(
        "tr",
      )!;
      await user.click(
        within(daveRow).getByRole("button", {
          name: "Undo access removal for Dave Lingering",
        }),
      );

      // Reuses the add wording — the principal is going back into the desired set.
      expect(screen.getByText("Pending add")).toBeInTheDocument();
      const save = screen.getByRole("button", { name: "Save changes" });
      expect(save).not.toBeDisabled();

      await user.click(save);

      await waitFor(() => expect(putBody).toBeDefined());
      expect(putBody!.assignments.map((a) => a.principalId)).toEqual([
        "user-1",
        "dave-id",
      ]);
    });

    it("reverts the staged undo via Remove, back to the pending revoke", async () => {
      // Reverting means "not desired" again, which the server already wants —
      // so it discards the staged change instead of staging a removal.
      stubGetAssignments([
        userAssignment,
        lingeringRecord({ principalId: "dave-id" }),
      ]);
      renderTab();
      const user = userEvent.setup();

      const daveRow = (await screen.findByText("dave@example.com")).closest(
        "tr",
      )!;
      await user.click(
        within(daveRow).getByRole("button", {
          name: "Undo access removal for Dave Lingering",
        }),
      );
      expect(screen.getByText("Pending add")).toBeInTheDocument();

      const stagedRow = screen.getByText("dave@example.com").closest("tr")!;
      await user.click(
        within(stagedRow).getByRole("button", {
          name: "Remove access for Dave Lingering",
        }),
      );

      await waitFor(() =>
        expect(screen.queryByText("Pending add")).not.toBeInTheDocument(),
      );
      // Back to the server's view, not staged as a fresh removal.
      expect(screen.getByText("Revoke failed")).toBeInTheDocument();
      expect(screen.queryByText("Pending remove")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
    });

    it("hides the Retry alert once a change is staged", async () => {
      // Retry submits the same desired set Save does, so offering both would be
      // two buttons for one action.
      stubGetAssignments([
        userAssignment,
        lingeringRecord({ principalId: "dave-id" }),
      ]);
      renderTab();
      const user = userEvent.setup();

      expect(
        await screen.findByText("Some access changes did not apply"),
      ).toBeInTheDocument();

      const daveRow = screen.getByText("dave@example.com").closest("tr")!;
      await user.click(
        within(daveRow).getByRole("button", {
          name: "Undo access removal for Dave Lingering",
        }),
      );

      await waitFor(() =>
        expect(
          screen.queryByText("Some access changes did not apply"),
        ).not.toBeInTheDocument(),
      );
    });
  });

  it("offers a Retry that reapplies the desired set without staging an edit", async () => {
    // Save is gated on isDirty, so without this affordance the only way to
    // recover from a failed reconcile is to fake an edit.
    stubGetAssignments([
      userAssignment,
      desiredOnly({ principalId: "carol-id", syncStatus: "grantFailed" }),
    ]);

    let putBody: { assignments: { principalId: string }[] } | undefined;
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        async ({ request }) => {
          putBody = (await request.json()) as typeof putBody;
          return HttpResponse.json({
            status: "success",
            data: { desiredCount: 2 },
          });
        },
      ),
    );

    renderTab();
    const user = userEvent.setup();

    expect(
      await screen.findByText("Some access changes did not apply"),
    ).toBeInTheDocument();

    // Save stays disabled (nothing staged); Retry is the recovery path.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(putBody).toBeDefined());
    expect(putBody!.assignments.map((a) => a.principalId)).toContain(
      "carol-id",
    );
  });

  it("hides the Retry affordance while the backend is still processing", async () => {
    // A transitional row is not a failure, so there is nothing to retry.
    stubGetAssignments(
      [
        userAssignment,
        desiredOnly({ principalId: "carol-id", syncStatus: "granting" }),
      ],
      "UPDATE",
    );
    renderTab();

    expect(await screen.findByText("Granting")).toBeInTheDocument();
    expect(
      screen.queryByText("Some access changes did not apply"),
    ).not.toBeInTheDocument();
  });

  it("drops an unsaved add outright when Remove is clicked on it", async () => {
    stubGetAssignments([ownerAssignment]);
    renderTab();
    const user = userEvent.setup();

    // Wait for the owner row.
    expect(
      (await screen.findAllByText("owner@example.com")).length,
    ).toBeGreaterThan(0);

    // Add carol via typeahead stub.
    await user.click(screen.getByRole("button", { name: "Add carol-id" }));
    expect(screen.getByText("Pending add")).toBeInTheDocument();
    expect(screen.getByText("Carol Davis")).toBeInTheDocument();

    // Remove the unsaved add — it should disappear entirely (not stage as "removed").
    const carolRow = screen.getByText("Carol Davis").closest("tr")!;
    await user.click(
      within(carolRow).getByRole("button", {
        name: "Remove access for Carol Davis",
      }),
    );
    expect(screen.queryByText("Carol Davis")).not.toBeInTheDocument();
    expect(screen.queryByText("Pending remove")).not.toBeInTheDocument();
  });

  it("shows Undo button on removed rows and restores them on click", async () => {
    stubGetAssignments([ownerAssignment, userAssignment]);
    renderTab();
    const user = userEvent.setup();

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    // Stage alice for removal.
    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );
    expect(screen.getByText("Pending remove")).toBeInTheDocument();

    // Undo button should appear.
    const updatedRow = screen
      .getByText("owner-test@example.com")
      .closest("tr")!;
    const undoButton = within(updatedRow).getByRole("button", {
      name: "Undo access removal for Alice Smith",
    });
    expect(undoButton).toBeInTheDocument();

    // Click Undo — row returns to current state.
    await user.click(undoButton);
    await waitFor(() =>
      expect(screen.queryByText("Pending remove")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("shows error toast when save fails", async () => {
    const { showErrorToast: mockErrorToast } =
      await import("@amzn/innovation-sandbox-frontend/components/Toast");
    stubGetAssignments([ownerAssignment, userAssignment]);
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => HttpResponse.json({ status: "error" }, { status: 500 }),
      ),
    );
    renderTab();
    const user = userEvent.setup();

    expect(
      (await screen.findAllByText("alice@example.com")).length,
    ).toBeGreaterThan(0);

    // Stage a removal so Save is enabled.
    const aliceRow = screen.getByText("owner-test@example.com").closest("tr")!;
    await user.click(
      within(aliceRow).getByRole("button", {
        name: "Remove access for Alice Smith",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mockErrorToast).toHaveBeenCalled());
  });

  it("renders ErrorPanel when the assignments query fails", async () => {
    server.use(
      http.get(
        `${getConfig().ApiUrl}/leases/${LEASE_ROUTE_ID}/assignments`,
        () => HttpResponse.json({ status: "error" }, { status: 500 }),
      ),
    );

    const Wrapper = createQueryClientWrapper();
    const { MemoryRouter } = await import("react-router-dom");
    render(
      <MemoryRouter>
        <Wrapper>
          <AssignmentsTab
            lease={lease}
            leaseRouteId={LEASE_ROUTE_ID}
            leaseSharingEnabled={true}
            enablePrincipalSearch={true}
            isElevated={false}
            isOwner={true}
          />
        </Wrapper>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText(
        /There was a problem loading assignments for this lease/i,
      ),
    ).toBeInTheDocument();
  });

  it("disables Remove and Undo buttons while backend is processing", async () => {
    stubGetAssignments([ownerAssignment, userAssignment], "UPDATE");
    renderTab();

    const aliceRow = (
      await screen.findByText("owner-test@example.com")
    ).closest("tr")!;

    // Remove button should be disabled while lock is held.
    const removeBtn = within(aliceRow).getByRole("button", {
      name: "Remove access for Alice Smith",
    });
    expect(removeBtn).toBeDisabled();
  });
});
// Ensure createWrapper isn't tree-shaken; some Cloudscape tests need it for
// future expansion (e.g., asserting on the typeahead dropdown).
void createWrapper;
