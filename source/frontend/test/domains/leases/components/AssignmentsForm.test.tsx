// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { zodResolver } from "@hookform/resolvers/zod";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";

import { AssignmentsForm } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentsForm";
import {
  RequestLeaseFormValues,
  RequestLeaseValidationSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leases/validation";
import { GroupAssignmentMode } from "@amzn/innovation-sandbox-shared/types/configuration.js";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

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
const unavailablePermissionSet: PermissionSetReference = {
  ...developerPermissionSet,
  name: "UnavailableAccess",
  availability: "UNAVAILABLE",
};

// Test-specific principals rendered by the shared deterministic typeahead stub.
const TYPEAHEAD_FIXTURE = [
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

// Captures form state into a ref-like object so tests can assert on the
// shape after interactions.
function renderWithForm(
  captured: { values: RequestLeaseFormValues | null },
  componentProps?: {
    owner?: {
      principalId: string;
      displayName?: string;
      email?: string;
    };
    groupAssignmentMode?: GroupAssignmentMode;
    defaultPermissionSet?: PermissionSetReference;
    allowedPermissionSets?: PermissionSetReference[];
    initialAssignments?: RequestLeaseFormValues["assignments"];
  },
) {
  const Harness = () => {
    const methods = useForm<RequestLeaseFormValues>({
      resolver: zodResolver(RequestLeaseValidationSchema),
      mode: "all",
      defaultValues: {
        leaseTemplateUuid: "00000000-0000-0000-0000-000000000001",
        acceptTerms: false,
        comments: "",
        assignments: componentProps?.initialAssignments,
      },
    });

    const { watch } = methods;
    const all = watch();
    useEffect(() => {
      captured.values = all;
    });

    return (
      <FormProvider {...methods}>
        <AssignmentsForm
          owner={componentProps?.owner}
          groupAssignmentMode={componentProps?.groupAssignmentMode}
          defaultPermissionSet={
            componentProps?.defaultPermissionSet ?? developerPermissionSet
          }
          allowedPermissionSets={
            componentProps?.allowedPermissionSets ?? [
              developerPermissionSet,
              auditorPermissionSet,
            ]
          }
        />
      </FormProvider>
    );
  };

  return render(<Harness />);
}

async function togglePermissionSet(
  displayName: string,
  permissionSetArn: string,
) {
  const row = (await screen.findByText(displayName)).closest("tr")!;
  const select = createWrapper(row).findSelect()!;
  if (
    select.findTrigger().getElement().getAttribute("aria-expanded") !== "true"
  ) {
    select.openDropdown();
  }
  select.selectOptionByValue(permissionSetArn, {
    expandToViewport: true,
  });
}

describe("AssignmentsForm", () => {
  it("renders the empty state when no assignments are staged", () => {
    renderWithForm({ values: null });
    expect(screen.getByText("No one added yet")).toBeInTheDocument();
  });

  it("defaults to a users-only search", () => {
    renderWithForm({ values: null });

    expect(screen.getByTestId("typeahead-stub")).toHaveAttribute(
      "data-search-type",
      "users",
    );
    expect(
      screen.queryByRole("button", { name: "Add group-1" }),
    ).not.toBeInTheDocument();
  });

  it("stages a typeahead pick into form state", async () => {
    const captured = { values: null as RequestLeaseFormValues | null };
    renderWithForm(captured);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add user-1" }));

    // The row appears in the table.
    expect(screen.getByText("Alice Smith")).toBeInTheDocument();

    // Form state carries the wire fields plus display fields (kept so the
    // table can render across wizard back/forward navigation).
    expect(captured.values?.assignments).toEqual([
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "Alice Smith",
        email: "alice@example.com",
        permissionSetArn: developerPermissionSet.permissionSetArn,
      },
    ]);
  });

  it("removes a staged row when Remove is clicked", async () => {
    const captured = { values: null as RequestLeaseFormValues | null };
    renderWithForm(captured, {
      groupAssignmentMode: GroupAssignmentMode.ALL,
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add user-1" }));
    await user.click(screen.getByRole("button", { name: "Add group-1" }));
    expect(screen.getByText("Engineering")).toBeInTheDocument();

    const aliceRow = screen.getByText("Alice Smith").closest("tr")!;
    await user.click(within(aliceRow).getByRole("button", { name: "Remove" }));

    expect(screen.queryByText("Alice Smith")).not.toBeInTheDocument();
    expect(captured.values?.assignments).toEqual([
      {
        principalId: "group-1",
        principalType: "GROUP",
        displayName: "Engineering",
        permissionSetArn: developerPermissionSet.permissionSetArn,
      },
    ]);
  });

  it("excludes already-staged principals from the typeahead suggestions", async () => {
    renderWithForm(
      { values: null },
      { groupAssignmentMode: GroupAssignmentMode.ALL },
    );
    const user = userEvent.setup();

    expect(
      screen.getByRole("button", { name: "Add user-1" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add user-1" }));

    expect(
      screen.queryByRole("button", { name: "Add user-1" }),
    ).not.toBeInTheDocument();
    // The other one is still selectable.
    expect(
      screen.getByRole("button", { name: "Add group-1" }),
    ).toBeInTheDocument();
  });

  it("replaces the permission set selected for a principal", async () => {
    const captured = { values: null as RequestLeaseFormValues | null };
    renderWithForm(captured, {
      defaultPermissionSet: developerPermissionSet,
      allowedPermissionSets: [developerPermissionSet, auditorPermissionSet],
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Add user-1" }));
    expect(
      screen.queryByRole("button", { name: "Add user-1" }),
    ).not.toBeInTheDocument();
    await togglePermissionSet(
      "Alice Smith",
      auditorPermissionSet.permissionSetArn,
    );

    expect(screen.getAllByText("Alice Smith")).toHaveLength(1);
    expect(captured.values?.assignments).toEqual([
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "Alice Smith",
        email: "alice@example.com",
        permissionSetArn: auditorPermissionSet.permissionSetArn,
      },
    ]);
    expect(
      screen.queryByRole("button", { name: "Add user-1" }),
    ).not.toBeInTheDocument();
  });

  it("includes the owner as a non-removable assignment", async () => {
    const captured = { values: null as RequestLeaseFormValues | null };
    renderWithForm(captured, {
      owner: {
        principalId: "user-1",
        displayName: "Alice Smith",
        email: "alice@example.com",
      },
      groupAssignmentMode: GroupAssignmentMode.ALL,
    });
    const user = userEvent.setup();

    // The typeahead should exclude alice (owner) from suggestions entirely.
    expect(
      screen.queryByRole("button", { name: "Add user-1" }),
    ).not.toBeInTheDocument();

    // The group is still available
    await user.click(screen.getByRole("button", { name: "Add group-1" }));

    expect(captured.values?.assignments).toEqual([
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "Alice Smith",
        email: "alice@example.com",
        permissionSetArn: developerPermissionSet.permissionSetArn,
      },
      {
        principalId: "group-1",
        principalType: "GROUP",
        displayName: "Engineering",
        permissionSetArn: developerPermissionSet.permissionSetArn,
      },
    ]);
    const ownerRow = screen.getByText("Alice Smith").closest("tr")!;
    expect(
      within(ownerRow).queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
  });

  it("allows the owner to choose an allowed permission set", async () => {
    const captured = { values: null as RequestLeaseFormValues | null };
    renderWithForm(captured, {
      owner: {
        principalId: "owner-1",
        displayName: "Lease Owner",
        email: "owner@example.com",
      },
      defaultPermissionSet: developerPermissionSet,
      allowedPermissionSets: [developerPermissionSet, auditorPermissionSet],
    });

    await togglePermissionSet(
      "Lease Owner",
      auditorPermissionSet.permissionSetArn,
    );

    await waitFor(() =>
      expect(captured.values?.assignments).toEqual([
        {
          principalId: "owner-1",
          principalType: "USER",
          displayName: "Lease Owner",
          email: "owner@example.com",
          permissionSetArn: auditorPermissionSet.permissionSetArn,
        },
      ]),
    );
  });

  it("allows an unavailable selected permission set to be removed", async () => {
    const captured = { values: null as RequestLeaseFormValues | null };
    renderWithForm(captured, {
      owner: {
        principalId: "11111111-1111-4111-8111-111111111111",
        displayName: "Lease Owner",
        email: "owner@example.com",
      },
      defaultPermissionSet: unavailablePermissionSet,
      allowedPermissionSets: [unavailablePermissionSet, auditorPermissionSet],
    });

    await togglePermissionSet(
      "Lease Owner",
      auditorPermissionSet.permissionSetArn,
    );

    await waitFor(() =>
      expect(captured.values?.assignments).toEqual([
        expect.objectContaining({
          principalId: "11111111-1111-4111-8111-111111111111",
          permissionSetArn: auditorPermissionSet.permissionSetArn,
        }),
      ]),
    );
  });

  it("allows a count-neutral owner permission-set replacement at capacity", async () => {
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const captured = { values: null as RequestLeaseFormValues | null };
    renderWithForm(captured, {
      owner: {
        principalId: ownerId,
        displayName: "Lease Owner",
        email: "owner@example.com",
      },
      defaultPermissionSet: developerPermissionSet,
      allowedPermissionSets: [developerPermissionSet, auditorPermissionSet],
      initialAssignments: [
        {
          principalId: ownerId,
          principalType: "USER",
          displayName: "Lease Owner",
          email: "owner@example.com",
          permissionSetArn: developerPermissionSet.permissionSetArn,
        },
        ...Array.from({ length: 19 }, (_, index) => ({
          principalId: `00000000-0000-4000-8000-${index
            .toString(16)
            .padStart(12, "0")}`,
          principalType: "USER" as const,
          permissionSetArn: developerPermissionSet.permissionSetArn,
        })),
      ],
    });

    await togglePermissionSet(
      "Lease Owner",
      auditorPermissionSet.permissionSetArn,
    );
    expect(
      screen.getByText("This lease has reached the maximum of 20 principals."),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(captured.values?.assignments).toHaveLength(20);
      expect(captured.values?.assignments).toContainEqual(
        expect.objectContaining({
          principalId: ownerId,
          permissionSetArn: auditorPermissionSet.permissionSetArn,
        }),
      );
    });
  });
});
