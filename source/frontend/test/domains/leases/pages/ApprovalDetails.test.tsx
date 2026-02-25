// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ApprovalDetails } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/ApprovalDetails";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { createPendingLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { mockLeaseApi } from "@amzn/innovation-sandbox-frontend/mocks/mockApi";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

// Mock the useNavigate hook
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ leaseId: "test-lease-id" }),
  };
});

// Mock the useBreadcrumb hook
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
}));

describe("ApprovalDetails", () => {
  const mockLease = createPendingLease({
    uuid: "test-lease-id",
  });

  beforeEach(() => {
    mockLeaseApi.returns(mockLease);
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <ModalProvider>
        <BrowserRouter>
          <ApprovalDetails />
        </BrowserRouter>
      </ModalProvider>,
    );

  test("renders lease details correctly", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        mockLease.userEmail,
      );
      expect(
        screen.getByText(mockLease.originalLeaseTemplateName, {
          selector: "p",
        }),
      ).toBeInTheDocument();
    });
  });

  test("displays LeaseSummary component", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });
  });

  test("shows Approve and Deny buttons", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Approve" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    });
  });

  test("handles Approve action correctly", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Approve" }),
      ).toBeInTheDocument();
    });

    const approveButton = screen.getByRole("button", { name: "Approve" });
    await userEvent.click(approveButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);

    expect(
      modalContent.getByText("Are you sure you want to approve the request?"),
    ).toBeInTheDocument();
  });

  test("handles Deny action correctly", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    });

    const denyButton = screen.getByRole("button", { name: "Deny" });
    await userEvent.click(denyButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);

    expect(
      modalContent.getByText("Are you sure you want to deny the request?"),
    ).toBeInTheDocument();
  });

  test("handles error when fetching lease details", async () => {
    mockLeaseApi.returns(null);
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("There was a problem loading this lease."),
      ).toBeInTheDocument();
    });
  });
});
