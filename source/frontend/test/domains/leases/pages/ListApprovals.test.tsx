// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { ListApprovals } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/ListApprovals";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { createPendingLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { mockLeaseApi } from "@amzn/innovation-sandbox-frontend/mocks/mockApi";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

// Mock ResizeObserver
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;

// Mock the useBreadcrumb hook
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
}));

describe("ListApprovals", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <ModalProvider>
        <BrowserRouter>
          <ListApprovals />
        </BrowserRouter>
      </ModalProvider>,
    );

  const mockPendingLease = createPendingLease();

  test("renders the header correctly", async () => {
    renderComponent();
    const wrapper = createWrapper();
    const header = wrapper.findHeader();
    expect(header?.findHeadingText()?.getElement()).toHaveTextContent(
      "Approvals",
    );
    expect(header?.findDescription()?.getElement()).toHaveTextContent(
      "Manage requests to lease sandbox accounts",
    );
  });

  test("displays pending approvals when they exist", async () => {
    const mockPendingLeases = [createPendingLease(), createPendingLease()];
    mockLeaseApi.returns(mockPendingLeases);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(mockPendingLeases[0].userEmail),
      ).toBeInTheDocument();
      expect(
        screen.getByText(mockPendingLeases[1].userEmail),
      ).toBeInTheDocument();
      expect(
        screen.getByText(mockPendingLeases[0].originalLeaseTemplateName),
      ).toBeInTheDocument();
      expect(
        screen.getByText(mockPendingLeases[1].originalLeaseTemplateName),
      ).toBeInTheDocument();
    });
  });

  test("displays 'No items to display' when no pending approvals", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      const wrapper = createWrapper();
      const table = wrapper.findTable();
      expect(table?.findEmptySlot()?.getElement()).toHaveTextContent(
        "No items to display",
      );
    });
  });

  test("allows selecting and deselecting requests", async () => {
    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });
    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const checkbox = table?.findRowSelectionArea(1)?.findCheckbox();

    await userEvent.click(checkbox!.getElement());
    expect(table?.findSelectedRows()).toHaveLength(1);

    await userEvent.click(checkbox!.getElement());

    expect(table?.findSelectedRows()).toHaveLength(0);
  });

  test("shows modal when approve action is clicked", async () => {
    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const rows = table?.findRows();
    await userEvent.click(
      rows![0].getElement().querySelector('input[type="checkbox"]')!,
    );

    const actionButton = wrapper.findButtonDropdown();
    await userEvent.click(actionButton!.findNativeButton().getElement());

    const approveButton = screen.getByText("Approve request(s)");
    await userEvent.click(approveButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);

    expect(modalContent.getByText("Approve request(s)")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        modalContent.getByText(mockPendingLease.userEmail),
      ).toBeInTheDocument(),
    );
  });

  test("shows modal when deny action is clicked", async () => {
    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const rows = table?.findRows();
    await userEvent.click(
      rows![0].getElement().querySelector('input[type="checkbox"]')!,
    );

    const actionButton = wrapper.findButtonDropdown();
    await userEvent.click(actionButton!.findNativeButton().getElement());

    const approveButton = screen.getByText("Deny request(s)");
    await userEvent.click(approveButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);

    expect(modalContent.getByText("Deny request(s)")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        modalContent.getByText(mockPendingLease.userEmail),
      ).toBeInTheDocument(),
    );
  });

  test("displays comments in table", async () => {
    const leaseWithComments = createPendingLease({
      comments: "Need this for testing project",
    });
    mockLeaseApi.returns([leaseWithComments]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("Need this for testing project"),
      ).toBeInTheDocument();
    });
  });

  test("successfully approves lease requests", async () => {
    const { http, HttpResponse } = await import("msw");
    const { config } = await import(
      "@amzn/innovation-sandbox-frontend/helpers/config"
    );

    server.use(
      http.post(`${config.ApiUrl}/leases/:leaseId/review`, () => {
        return HttpResponse.json({
          status: "success",
          data: {},
        });
      }),
    );

    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const rows = table?.findRows();
    await userEvent.click(
      rows![0].getElement().querySelector('input[type="checkbox"]')!,
    );

    const actionButton = wrapper.findButtonDropdown();
    await userEvent.click(actionButton!.findNativeButton().getElement());

    const approveButton = screen.getByText("Approve request(s)");
    await userEvent.click(approveButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Success")).toBeInTheDocument();
    });
  });

  test("successfully denies lease requests", async () => {
    const { http, HttpResponse } = await import("msw");
    const { config } = await import(
      "@amzn/innovation-sandbox-frontend/helpers/config"
    );

    server.use(
      http.post(`${config.ApiUrl}/leases/:leaseId/review`, () => {
        return HttpResponse.json({
          status: "success",
          data: {},
        });
      }),
    );

    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const rows = table?.findRows();
    await userEvent.click(
      rows![0].getElement().querySelector('input[type="checkbox"]')!,
    );

    const actionButton = wrapper.findButtonDropdown();
    await userEvent.click(actionButton!.findNativeButton().getElement());

    const denyButton = screen.getByText("Deny request(s)");
    await userEvent.click(denyButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Success")).toBeInTheDocument();
    });
  });

  test("handles approval failure and shows error", async () => {
    const { http, HttpResponse } = await import("msw");
    const { config } = await import(
      "@amzn/innovation-sandbox-frontend/helpers/config"
    );

    server.use(
      http.post(`${config.ApiUrl}/leases/:leaseId/review`, () => {
        return HttpResponse.json(
          {
            status: "error",
            message: "Failed to approve lease",
          },
          { status: 500 },
        );
      }),
    );

    mockLeaseApi.returns([mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const rows = table?.findRows();
    await userEvent.click(
      rows![0].getElement().querySelector('input[type="checkbox"]')!,
    );

    const actionButton = wrapper.findButtonDropdown();
    await userEvent.click(actionButton!.findNativeButton().getElement());

    const approveButton = screen.getByText("Approve request(s)");
    await userEvent.click(approveButton);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
  });
});
