// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { SelectLeaseTemplate } from "@amzn/innovation-sandbox-frontend/domains/leases/components/SelectLeaseTemplate";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  mockAdvancedLeaseTemplate,
  mockBasicLeaseTemplate,
  mockLeaseTemplates,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import {
  ApiPaginatedResult,
  ApiResponse,
} from "@amzn/innovation-sandbox-frontend/types";
import { MemoryRouter } from "react-router-dom";

describe("SelectLeaseTemplate", () => {
  const mockOnChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderComponent = (value = "") =>
    renderWithQueryClient(
      <MemoryRouter>
        <SelectLeaseTemplate value={value} onChange={mockOnChange} />
      </MemoryRouter>,
    );

  test("renders lease templates correctly", async () => {
    renderComponent();

    await waitFor(() => {
      const cards = createWrapper().findCards();
      expect(cards?.findItems()).toHaveLength(2);

      const cardHeaders = cards
        ?.findItems()
        .map((item) => item.findCardHeader()?.getElement().textContent);
      expect(cardHeaders).toContain(mockBasicLeaseTemplate.name);
      expect(cardHeaders).toContain(mockAdvancedLeaseTemplate.name);
    });
  });

  test("handles error when fetching lease templates fails", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json(
          { status: "error", message: "Failed to fetch lease templates" },
          { status: 500 },
        );
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("Could not load lease templates at the moment."),
      ).toBeInTheDocument();
    });
  });

  test("displays loading state while fetching templates", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return HttpResponse.json({
          status: "success",
          data: { result: mockLeaseTemplates, nextPageIdentifier: null },
        } as ApiResponse<ApiPaginatedResult<LeaseTemplate>>);
      }),
    );

    renderComponent();

    expect(screen.getByText("Loading lease templates...")).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.queryByText("Loading lease templates..."),
      ).not.toBeInTheDocument();
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });
  });

  test("allows selecting a lease template", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });

    const basicTemplateCard = screen.getByText(mockBasicLeaseTemplate.name);
    await user.click(basicTemplateCard);

    expect(mockOnChange).toHaveBeenCalledWith(mockBasicLeaseTemplate.uuid);
  });

  test("displays no templates message when no templates are available", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json({
          status: "success",
          data: { result: [], nextPageIdentifier: null },
        } as ApiResponse<ApiPaginatedResult<LeaseTemplate>>);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("No lease templates configured."),
      ).toBeInTheDocument();
    });
  });

  test("handles value prop correctly", async () => {
    renderComponent(mockBasicLeaseTemplate.uuid);

    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });

    // Check that the template with the given value is selected
    await waitFor(() => {
      const cards = createWrapper().findCards();
      const selectedItems = cards?.findSelectedItems();
      expect(selectedItems).toHaveLength(1);
    });
  });

  test("displays correct details for each template", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
      expect(
        screen.getByText(mockAdvancedLeaseTemplate.name),
      ).toBeInTheDocument();
    });

    if (mockBasicLeaseTemplate.description) {
      expect(
        screen.getByText(mockBasicLeaseTemplate.description),
      ).toBeInTheDocument();
    }
    if (mockAdvancedLeaseTemplate.description) {
      expect(
        screen.getByText(mockAdvancedLeaseTemplate.description),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByText(`$${mockBasicLeaseTemplate.maxSpend}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`$${mockAdvancedLeaseTemplate.maxSpend}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        mockBasicLeaseTemplate.requiresApproval
          ? "Requires approval"
          : "No approval required",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        mockAdvancedLeaseTemplate.requiresApproval
          ? "Requires approval"
          : "No approval required",
      ),
    ).toBeInTheDocument();

    // Check visibility indicators are displayed
    const visibilityLabels = screen.getAllByText(/Public|Private/);
    expect(visibilityLabels.length).toBeGreaterThan(0);
  });

  test("filters templates when searching by name", async () => {
    const searchableTemplates = [
      { ...mockBasicLeaseTemplate, name: "Template A" },
      { ...mockAdvancedLeaseTemplate, name: "Template B" },
    ];

    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json({
          status: "success",
          data: { result: searchableTemplates, nextPageIdentifier: null },
        } as ApiResponse<ApiPaginatedResult<LeaseTemplate>>);
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Template A")).toBeInTheDocument();
      expect(screen.getByText("Template B")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search by template name");
    await user.type(searchInput, "Template A");

    // Only the Template A should be visible
    await waitFor(() => {
      expect(screen.getByText("Template A")).toBeInTheDocument();
      expect(screen.queryByText("Template B")).not.toBeInTheDocument();
    });

    // Clear the search and both should be visible again
    await user.clear(searchInput);

    await waitFor(() => {
      expect(screen.getByText("Template A")).toBeInTheDocument();
      expect(screen.getByText("Template B")).toBeInTheDocument();
    });
  });

  test("shows 'no matching templates' message when search has no results", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockBasicLeaseTemplate.name)).toBeInTheDocument();
    });

    // Find the search input and type a search term that won't match any templates
    const searchInput = screen.getByPlaceholderText("Search by template name");
    await user.type(searchInput, "NonExistentTemplate");

    // Should show the no results message
    await waitFor(() => {
      expect(screen.getByText("No matching templates")).toBeInTheDocument();
      expect(
        screen.getByText(
          "No lease templates match your search term. Try a different search.",
        ),
      ).toBeInTheDocument();
    });
  });

  test("paginates templates when there are more than LEASE_TEMPLATES_PER_PAGE", async () => {
    // Create enough templates to trigger pagination
    const manyTemplates = Array.from({ length: 15 }, (_, i) => ({
      ...mockBasicLeaseTemplate,
      uuid: `template-${i}`,
      name: `Template ${i + 1}`,
    }));

    server.use(
      http.get(`${config.ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json({
          status: "success",
          data: { result: manyTemplates, nextPageIdentifier: null },
        } as ApiResponse<ApiPaginatedResult<LeaseTemplate>>);
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    // Wait for the first page to load
    await waitFor(() => {
      expect(screen.getByText("Template 1")).toBeInTheDocument();
    });

    // Check that pagination controls are visible
    const pagination = createWrapper().findPagination();
    expect(pagination).not.toBeNull();

    // First page should show templates 1-12
    expect(screen.getByText("Template 1")).toBeInTheDocument();
    expect(screen.getByText("Template 12")).toBeInTheDocument();
    expect(screen.queryByText("Template 13")).not.toBeInTheDocument();

    // Navigate to the second page
    const nextPageButton = pagination?.findNextPageButton();
    await user.click(nextPageButton?.getElement() as HTMLElement);

    // Second page should show templates 13-15
    await waitFor(() => {
      expect(screen.queryByText("Template 1")).not.toBeInTheDocument();
      expect(screen.getByText("Template 13")).toBeInTheDocument();
      expect(screen.getByText("Template 15")).toBeInTheDocument();
    });
  });
});
