// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@cloudscape-design/components";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AssignmentsTable,
  type AssignmentTableOperationBase,
  type AssignmentTablePrincipal,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentsTable";

type TestAssignment = {
  rowId: string;
};

type TestOperation = AssignmentTableOperationBase & {
  permissionSetName: string;
  status: string;
};

const operation = (
  rowId: string,
  action: TestOperation["action"],
): TestOperation => ({
  kind: "operation",
  rowId,
  action,
  permissionSetName: `${rowId} permission set`,
  status: `${rowId} status`,
});

const principal = ({
  rowId,
  displayName,
  operations = [],
  principalType = "USER",
  isOwner = false,
  subtitle,
}: {
  rowId: string;
  displayName: string;
  operations?: TestOperation[];
  principalType?: "USER" | "GROUP";
  isOwner?: boolean;
  subtitle?: string;
}): AssignmentTablePrincipal<TestAssignment, TestOperation> => ({
  kind: "principal",
  rowId,
  principalId: `${rowId}-id`,
  principalType,
  displayName,
  subtitle,
  isOwner,
  assignment: { rowId: `${rowId}-assignment` },
  operations,
});

describe("AssignmentsTable", () => {
  it("renders editable principal rows and an optional toolbar", () => {
    const renderActions = vi.fn(() => <Button>Remove</Button>);

    render(
      <AssignmentsTable<TestAssignment, TestOperation>
        principals={[
          principal({
            rowId: "owner",
            displayName: "Lease owner",
            isOwner: true,
            subtitle: "owner@example.com",
          }),
          principal({
            rowId: "group",
            displayName: "Developers",
            principalType: "GROUP",
          }),
        ]}
        mode="edit"
        empty="No assignments"
        toolbarStart={<span>Principal search</span>}
        renderPermissionSet={(item) =>
          item.kind === "principal" ? "DeveloperAccess" : ""
        }
        renderActions={renderActions}
      />,
    );

    expect(screen.getByText("Principal search")).toBeInTheDocument();
    expect(screen.getByText("Lease owner")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(screen.getByText("Developers")).toBeInTheDocument();
    expect(screen.getAllByText("Group")).toHaveLength(2);
    expect(screen.getAllByText("DeveloperAccess")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
    expect(renderActions).toHaveBeenCalled();
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Expand all" }),
    ).not.toBeInTheDocument();
  });

  it("renders management columns and expandable operation details", async () => {
    const user = userEvent.setup();
    const grant = operation("grant", "grant");
    const revoke = operation("revoke", "revoke");

    render(
      <AssignmentsTable<TestAssignment, TestOperation>
        principals={[
          principal({
            rowId: "alice",
            displayName: "Alice",
            subtitle: "alice@example.com",
            operations: [grant, revoke],
          }),
        ]}
        mode="management"
        empty="No assignments"
        renderStatus={(item) =>
          item.kind === "operation" ? item.status : "Active"
        }
        renderPermissionSet={(item) =>
          item.kind === "operation"
            ? item.permissionSetName
            : "2 permission sets"
        }
        renderAddedBy={(item) =>
          item.kind === "operation" ? "System" : undefined
        }
        renderAddedDate={(item) =>
          item.kind === "operation" ? "Just now" : undefined
        }
      />,
    );

    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Added by")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText("Grant access")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand all" }));

    expect(screen.getByText("Grant access")).toBeInTheDocument();
    expect(screen.getByText("Revoke access")).toBeInTheDocument();
    expect(screen.getByText(grant.permissionSetName)).toBeInTheDocument();
    expect(screen.getByText(revoke.permissionSetName)).toBeInTheDocument();
    expect(screen.getByText(grant.status)).toBeInTheDocument();
    expect(screen.getByText(revoke.status)).toBeInTheDocument();
    expect(screen.getAllByText("System")).toHaveLength(2);
    expect(screen.getAllByText("Just now")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Collapse all" }));

    expect(screen.queryByText("Grant access")).not.toBeInTheDocument();
    expect(screen.queryByText("Revoke access")).not.toBeInTheDocument();
  });

  it("supports expanding and collapsing a single principal", async () => {
    const user = userEvent.setup();

    render(
      <AssignmentsTable<TestAssignment, TestOperation>
        principals={[
          principal({
            rowId: "alice",
            displayName: "Alice",
            operations: [
              operation("grant", "grant"),
              operation("revoke", "revoke"),
            ],
          }),
        ]}
        mode="readonly"
        empty="No assignments"
        renderPermissionSet={(item) =>
          item.kind === "operation"
            ? item.permissionSetName
            : "2 permission sets"
        }
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Show permission set operations for Alice",
      }),
    );
    expect(screen.getByText("Grant access")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Hide permission set operations for Alice",
      }),
    );
    expect(screen.queryByText("Grant access")).not.toBeInTheDocument();
  });

  it("suppresses actions in readonly mode and renders the empty state", () => {
    const renderActions = vi.fn(() => <Button>Remove</Button>);
    const { rerender } = render(
      <AssignmentsTable<TestAssignment, TestOperation>
        principals={[
          principal({
            rowId: "alice",
            displayName: "Alice",
          }),
        ]}
        mode="readonly"
        empty="No assignments"
        renderPermissionSet={() => "DeveloperAccess"}
        renderActions={renderActions}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
    expect(renderActions).not.toHaveBeenCalled();

    rerender(
      <AssignmentsTable<TestAssignment, TestOperation>
        principals={[]}
        mode="readonly"
        empty="No assignments"
        renderPermissionSet={() => "DeveloperAccess"}
      />,
    );

    expect(screen.getByText("No assignments")).toBeInTheDocument();
  });

  it("uses the configured loading text", () => {
    render(
      <AssignmentsTable<TestAssignment, TestOperation>
        principals={[]}
        mode="readonly"
        empty="No assignments"
        loading
        loadingText="Fetching assignments"
        renderPermissionSet={() => "DeveloperAccess"}
      />,
    );

    expect(screen.getByText("Fetching assignments")).toBeInTheDocument();
  });
});
