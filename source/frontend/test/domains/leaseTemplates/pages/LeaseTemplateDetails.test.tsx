// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { LeaseTemplateDetails } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/LeaseTemplateDetails";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
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

  test("displays error panel when lease template fails to load", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates/${mockUuid}`, () => {
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

  test("displays duration section", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/Duration Settings/i)).toBeInTheDocument();
    });
  });
});
