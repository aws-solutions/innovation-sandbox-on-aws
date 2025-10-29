// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter as Router } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { Home } from "@amzn/innovation-sandbox-frontend/domains/home/pages/Home";
import { createActiveLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { mockLeaseApi } from "@amzn/innovation-sandbox-frontend/mocks/mockApi";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

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

vi.mock("@amzn/innovation-sandbox-frontend/helpers/AuthService", () => ({
  AuthService: {
    getCurrentUser: vi.fn().mockResolvedValue({ email: "test@example.com" }),
    getAccessToken: vi.fn().mockReturnValue("mocked-access-token"),
  },
}));

vi.mock("@amzn/innovation-sandbox-frontend/domains/settings/hooks", () => ({
  useGetConfigurations: () => ({
    data: {
      auth: {
        awsAccessPortalUrl: "https://mock-portal-url.com",
      },
    },
    isLoading: false,
    isError: false,
  }),
}));

describe("Home", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <Home />
      </Router>,
    );

  test("renders correctly", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      const header = createWrapper().findContentLayout()?.findHeader();
      expect(header?.getElement()).toBeInTheDocument();
      expect(header?.getElement()).toHaveTextContent(
        "Welcome to Innovation Sandbox on AWS",
      );
    });
  });

  test("displays the no account info when no leases are available", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      const infoPanel = createWrapper().findAlert();
      expect(infoPanel?.getElement()).toBeInTheDocument();
      expect(
        screen.getByText("You currently don't have any leases."),
      ).toBeInTheDocument();
    });
  });

  test("displays lease data when available", async () => {
    const mockLease1 = createActiveLease({
      originalLeaseTemplateName: "Lease 1",
      userEmail: "test@example.com",
      awsAccountId: "123456789011",
    });
    const mockLease2 = createActiveLease({
      originalLeaseTemplateName: "Lease 2",
      userEmail: "test@example.com",
      awsAccountId: "123456789012",
    });
    mockLeaseApi.returns([mockLease1, mockLease2]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("My Leases")).toBeInTheDocument();
      expect(screen.getByText("Lease 1")).toBeInTheDocument();
      expect(screen.getByText("Lease 2")).toBeInTheDocument();
      expect(screen.getByText("123456789011")).toBeInTheDocument();
      expect(screen.getByText("123456789012")).toBeInTheDocument();
    });
  });

  test("refreshes lease data when refresh button is clicked", async () => {
    const user = userEvent.setup();
    const mockLease = createActiveLease({
      userEmail: "test@example.com",
      originalLeaseTemplateName: "Test Lease Template",
      awsAccountId: "123456789012",
    });
    mockLeaseApi.returns([mockLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByLabelText("Refresh")).toBeInTheDocument();
    });

    const refreshButton = screen.getByLabelText("Refresh");
    await user.click(refreshButton);

    await waitFor(() => {
      expect(
        screen.getByText(mockLease.originalLeaseTemplateName),
      ).toBeInTheDocument();
    });
  });

  test("sets breadcrumb correctly", () => {
    renderComponent();

    expect(mockSetBreadcrumb).toHaveBeenCalledWith([
      { text: "Home", href: "/" },
    ]);
  });

  test("navigates to request page when 'Request lease' is clicked", async () => {
    const user = userEvent.setup();
    renderComponent();

    const requestButton = await screen.findByText("Request lease");
    await user.click(requestButton);

    expect(mockNavigate).toHaveBeenCalledWith("/request");
  });
});
