// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PendingAssignmentsList } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PendingAssignmentsList";
import { DesiredAssignmentWithDisplay } from "@amzn/innovation-sandbox-shared/types/lease.js";
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

describe("PendingAssignmentsList", () => {
  it("renders nothing when there are no desiredAssignments", () => {
    const { container } = render(<PendingAssignmentsList />);
    // Component returns null in the empty case; a real render would show
    // a Container header. Asserting on the absence of the header text is
    // the easiest invariant.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Planned access")).not.toBeInTheDocument();
  });

  it("renders nothing when desiredAssignments is empty", () => {
    const { container } = render(
      <PendingAssignmentsList desiredAssignments={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders user and group rows with display fields", () => {
    const desiredAssignments: DesiredAssignmentWithDisplay[] = [
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "Alice Smith",
        email: "alice@example.com",
      },
      {
        principalId: "group-1",
        principalType: "GROUP",
        displayName: "Engineering",
      },
    ];

    render(<PendingAssignmentsList desiredAssignments={desiredAssignments} />);

    expect(screen.getByText("Planned access")).toBeInTheDocument();

    // Alice's row has the display name (Name col) and email (Email/Group col).
    // alice@example.com appears in both the Name fallback and the Email/Group
    // column for users, so use findAll.
    const aliceCells = screen.getAllByText("Alice Smith");
    expect(aliceCells.length).toBeGreaterThan(0);

    // Engineering row renders the displayName and a Group label in the
    // Email / Group column. Two cells in the row match "Group" (the Type
    // column cell + the Email/Group fallback) — assert >=1 instead of
    // exactly one.
    const groupRow = screen.getByText("Engineering").closest("tr")!;
    expect(within(groupRow).getAllByText("Group").length).toBeGreaterThan(0);
  });

  it("falls back to email or principalId when displayName is missing", () => {
    const desiredAssignments: DesiredAssignmentWithDisplay[] = [
      {
        principalId: "user-with-email-only",
        principalType: "USER",
        email: "noname@example.com",
      },
      {
        principalId: "user-with-only-id",
        principalType: "USER",
      },
    ];

    render(<PendingAssignmentsList desiredAssignments={desiredAssignments} />);

    // Name falls back to email when displayName is missing. Email also
    // shows in the Email/Group column for users, so getAllByText.
    expect(screen.getAllByText("noname@example.com").length).toBeGreaterThan(0);
    expect(screen.getByText("user-with-only-id")).toBeInTheDocument();
  });

  it("renders the selected permission set and the default fallback", async () => {
    const desiredAssignments: DesiredAssignmentWithDisplay[] = [
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "Alice Smith",
        permissionSetArn: developerPermissionSet.permissionSetArn,
      },
      {
        principalId: "user-2",
        principalType: "USER",
        displayName: "Bob Smith",
      },
    ];

    render(
      <PendingAssignmentsList
        desiredAssignments={desiredAssignments}
        defaultPermissionSet={developerPermissionSet}
        allowedPermissionSets={[developerPermissionSet]}
      />,
    );

    expect(screen.getAllByText("DeveloperAccess")).toHaveLength(2);
  });

  it("resolves an explicit default ARN when the default is not in the allowed list", () => {
    render(
      <PendingAssignmentsList
        desiredAssignments={[
          {
            principalId: "user-1",
            principalType: "USER",
            permissionSetArn: developerPermissionSet.permissionSetArn,
          },
        ]}
        defaultPermissionSet={developerPermissionSet}
        allowedPermissionSets={[auditorPermissionSet]}
      />,
    );

    expect(screen.getByText("DeveloperAccess")).toBeInTheDocument();
  });

  it("keeps USER and GROUP rows distinct when their IDs match", () => {
    render(
      <PendingAssignmentsList
        desiredAssignments={[
          {
            principalId: "shared-id",
            principalType: "USER",
            displayName: "Shared user",
            permissionSetArn: developerPermissionSet.permissionSetArn,
          },
          {
            principalId: "shared-id",
            principalType: "GROUP",
            displayName: "Shared group",
            permissionSetArn: auditorPermissionSet.permissionSetArn,
          },
        ]}
        defaultPermissionSet={developerPermissionSet}
        allowedPermissionSets={[developerPermissionSet, auditorPermissionSet]}
      />,
    );

    expect(screen.getAllByText("Shared user")).toHaveLength(1);
    expect(screen.getByText("Shared group")).toBeInTheDocument();
    expect(screen.getByText("DeveloperAccess")).toBeInTheDocument();
    expect(screen.getByText("AuditorAccess")).toBeInTheDocument();
  });

  it("preserves an explicit ARN when its hydrated reference is unavailable", () => {
    const permissionSetArn =
      "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-2123456789abcdef";

    render(
      <PendingAssignmentsList
        desiredAssignments={[
          {
            principalId: "user-1",
            principalType: "USER",
            permissionSetArn,
          },
        ]}
      />,
    );

    expect(screen.getByText(permissionSetArn)).toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
  });
});
