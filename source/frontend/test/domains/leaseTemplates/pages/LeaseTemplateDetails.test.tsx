// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { LeaseTemplateDetails } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/LeaseTemplateDetails";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { mockAdvancedLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();
const mockUuid = mockAdvancedLeaseTemplate.uuid;

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ uuid: mockUuid }),
  };
});

describe("LeaseTemplateDetails", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <LeaseTemplateDetails />
      </Router>,
    );

  test("renders loading state initially", () => {
    renderComponent();
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  test("renders lease template details after loading", async () => {
    renderComponent();

    await waitFor(() => {
      // Name might appear multiple times (header, breadcrumb, etc), just check first one
      expect(
        screen.getAllByText(mockAdvancedLeaseTemplate.name)[0],
      ).toBeInTheDocument();
    });

    expect(screen.getByText(/Basic Details/i)).toBeInTheDocument();
    expect(screen.getByText(/Budget Settings/i)).toBeInTheDocument();
    expect(screen.getByText(/Duration Settings/i)).toBeInTheDocument();
  });

  test("renders hydrated permission-set details returned by the API", async () => {
    const defaultPermissionSet = {
      permissionSetArn:
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
      permissionSetId: "ps-0123456789abcdef",
      name: "DeveloperAccess",
      description: "Developer sandbox access",
      availability: "AVAILABLE",
    };
    const additionalPermissionSet = {
      permissionSetArn:
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
      permissionSetId: "ps-1123456789abcdef",
      name: "AuditorAccess",
      description: "Read-only sandbox access",
      availability: "AVAILABLE",
    };
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            defaultPermissionSet,
            allowedPermissionSets: [
              defaultPermissionSet,
              additionalPermissionSet,
            ],
          },
        }),
      ),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("DeveloperAccess")).toBeInTheDocument();
    });
    expect(screen.getByText("AuditorAccess")).toBeInTheDocument();
    expect(screen.getByText("Developer sandbox access")).toBeInTheDocument();
    expect(screen.getByText("Read-only sandbox access")).toBeInTheDocument();
  });

  test("displays error panel when lease template fails to load", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json(
          { status: "error", message: "Not found" },
          { status: 404 },
        );
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(/There was a problem loading this lease template/i),
      ).toBeInTheDocument();
    });
  });

  test("displays error panel when global configuration fails to load", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json(
          { status: "error", message: "Configuration unavailable" },
          { status: 500 },
        ),
      ),
    );

    renderComponent();

    expect(
      await screen.findByText(
        /There was a problem loading global configuration settings/i,
      ),
    ).toBeInTheDocument();
  });

  test("navigates to each remaining edit page", async () => {
    renderComponent();
    const user = userEvent.setup();

    await screen.findByText(/Budget Settings/i);
    const editButtons = screen.getAllByRole("button", { name: /^Edit$/ });
    expect(editButtons).toHaveLength(6);
    const destinations = [
      "blueprint",
      "budget",
      "duration",
      "cost-report",
      "sandbox-spaces",
    ];

    for (const [index, destination] of destinations.entries()) {
      await user.click(editButtons[index + 1]!);
      expect(mockNavigate).toHaveBeenLastCalledWith(
        `/lease_templates/${mockUuid}/edit/${destination}`,
      );
    }
  });

  test("navigates to edit basic details page", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getAllByText(mockAdvancedLeaseTemplate.name)[0],
      ).toBeInTheDocument();
    });

    const editButtons = screen.getAllByRole("button", { name: /edit/i });
    await user.click(editButtons[0]);

    expect(mockNavigate).toHaveBeenCalledWith(
      `/lease_templates/${mockUuid}/edit/basic`,
    );
  });

  test("navigates to edit permission profile page", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getAllByText(mockAdvancedLeaseTemplate.name)[0],
      ).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", { name: "Edit access and sharing" }),
    );

    expect(mockNavigate).toHaveBeenCalledWith(
      `/lease_templates/${mockUuid}/edit/access`,
    );
  });

  test("displays duration section", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/Duration Settings/i)).toBeInTheDocument();
    });
  });
});
