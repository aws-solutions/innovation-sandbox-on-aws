// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { FormProvider, useForm } from "react-hook-form";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { TemplateSelectionForm } from "@amzn/innovation-sandbox-frontend/domains/leases/components/TemplateSelectionForm";
import { LeaseTemplateView } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
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

const templateUuid = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

describe("TemplateSelectionForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const TestWrapper = ({
    defaultValues = {},
    children,
  }: {
    defaultValues?: Record<string, any>;
    children: React.ReactNode;
  }) => {
    const methods = useForm({
      defaultValues: {
        leaseTemplateUuid: "",
        ...defaultValues,
      },
    });

    return (
      <Router>
        <FormProvider {...methods}>{children}</FormProvider>
      </Router>
    );
  };

  const renderComponent = (defaultValues = {}, label?: string) =>
    renderWithQueryClient(
      <TestWrapper defaultValues={defaultValues}>
        <TemplateSelectionForm label={label} />
      </TestWrapper>,
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
      http.get(`${getConfig().ApiUrl}/leaseTemplates`, () => {
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
      http.get(`${getConfig().ApiUrl}/leaseTemplates`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return HttpResponse.json({
          status: "success",
          data: { result: mockLeaseTemplates, nextPageIdentifier: null },
        } as ApiResponse<ApiPaginatedResult<LeaseTemplateView>>);
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

    // Verify the card is selected
    await waitFor(() => {
      const cards = createWrapper().findCards();
      const selectedItems = cards?.findSelectedItems();
      expect(selectedItems).toHaveLength(1);
    });
  });

  test("clears staged assignments when the selected template changes", async () => {
    const AssignmentResetWrapper = () => {
      const methods = useForm({
        defaultValues: {
          leaseTemplateUuid: mockBasicLeaseTemplate.uuid,
          assignments: [{ principalId: "shared-1" }],
        },
      });
      const assignments = methods.watch("assignments");

      return (
        <Router>
          <FormProvider {...methods}>
            <TemplateSelectionForm clearAssignmentsOnChange />
            <span data-testid="assignment-count">
              {assignments?.length ?? 0}
            </span>
          </FormProvider>
        </Router>
      );
    };
    renderWithQueryClient(<AssignmentResetWrapper />);
    const user = userEvent.setup();

    await user.click(await screen.findByText(mockAdvancedLeaseTemplate.name));

    await waitFor(() =>
      expect(screen.getByTestId("assignment-count")).toHaveTextContent("0"),
    );
  });

  test("displays no templates message when no templates are available", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json({
          status: "success",
          data: { result: [], nextPageIdentifier: null },
        } as ApiResponse<ApiPaginatedResult<LeaseTemplateView>>);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("No lease templates configured."),
      ).toBeInTheDocument();
    });
  });

  test("handles default value correctly", async () => {
    renderComponent({ leaseTemplateUuid: mockBasicLeaseTemplate.uuid });

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
      const description = screen.getByText(mockBasicLeaseTemplate.description);
      expect(description).toBeInTheDocument();
      expect(description.style.webkitLineClamp).toBe("4");
      expect(description).toHaveStyle({ overflow: "hidden" });
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
    expect(screen.getByText("2 days")).toBeInTheDocument();
    expect(screen.getByText("3 days")).toBeInTheDocument();
    expect(screen.getByText("Approval required")).toBeInTheDocument();
  });

  test("displays blueprint metadata only when configured", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            result: [
              {
                ...mockBasicLeaseTemplate,
                blueprintName: "Hackathon",
              },
              {
                ...mockAdvancedLeaseTemplate,
                blueprintName: undefined,
              },
            ],
            nextPageIdentifier: null,
          },
        } as ApiResponse<ApiPaginatedResult<LeaseTemplateView>>);
      }),
    );

    renderComponent();

    expect(await screen.findByText("Hackathon")).toBeInTheDocument();
    expect(screen.getAllByText("Blueprint")).toHaveLength(1);
  });

  test.each(["mouse", "Enter", "Space"])(
    "shows a truncated description using %s without selecting the card",
    async (activation) => {
      const longDescription = "Narrow card description ".repeat(6).trim();
      const longDescriptionTemplate = {
        ...mockBasicLeaseTemplate,
        name: "Long description template",
        description: longDescription,
      };
      const clientHeightSpy = vi
        .spyOn(HTMLElement.prototype, "clientHeight", "get")
        .mockImplementation(function (this: HTMLElement) {
          return this.textContent === longDescription ? 80 : 0;
        });
      const scrollHeightSpy = vi
        .spyOn(HTMLElement.prototype, "scrollHeight", "get")
        .mockImplementation(function (this: HTMLElement) {
          return this.textContent === longDescription ? 120 : 0;
        });

      server.use(
        http.get(`${getConfig().ApiUrl}/leaseTemplates`, () => {
          return HttpResponse.json({
            status: "success",
            data: {
              result: [longDescriptionTemplate, mockAdvancedLeaseTemplate],
              nextPageIdentifier: null,
            },
          } as ApiResponse<ApiPaginatedResult<LeaseTemplateView>>);
        }),
      );

      renderComponent();
      const user = userEvent.setup();
      const description = await screen.findByText(longDescription);

      expect(description.style.webkitLineClamp).toBe("4");
      expect(description).toHaveStyle({ overflow: "hidden" });

      const descriptionButton = await screen.findByRole("button", {
        name: "View full description for Long description template",
      });
      if (activation === "mouse") {
        await user.click(descriptionButton);
      } else {
        descriptionButton.focus();
        await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
      }

      const modal = createWrapper().findModal();
      expect(modal?.isVisible()).toBe(true);
      expect(modal?.findHeader().getElement()).toHaveTextContent(
        "Long description template description",
      );
      expect(modal?.findContent().getElement()).toHaveTextContent(
        longDescription,
      );
      expect(createWrapper().findCards()?.findSelectedItems()).toHaveLength(0);

      clientHeightSpy.mockRestore();
      scrollHeightSpy.mockRestore();
    },
  );

  test("filters templates when searching by name", async () => {
    const searchableTemplates = [
      { ...mockBasicLeaseTemplate, name: "Template A" },
      { ...mockAdvancedLeaseTemplate, name: "Template B" },
    ];

    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json({
          status: "success",
          data: { result: searchableTemplates, nextPageIdentifier: null },
        } as ApiResponse<ApiPaginatedResult<LeaseTemplateView>>);
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
      uuid: templateUuid(i),
      name: `Template ${i + 1}`,
    }));

    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json({
          status: "success",
          data: { result: manyTemplates, nextPageIdentifier: null },
        } as ApiResponse<ApiPaginatedResult<LeaseTemplateView>>);
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

  test("renders with custom label", async () => {
    const customLabel = "Choose your template";
    renderComponent({}, customLabel);

    await waitFor(() => {
      expect(screen.getByText(customLabel)).toBeInTheDocument();
    });
  });

  test("resets to page 1 when search term changes", async () => {
    // 13 is the fewest templates that produce a second page (12 per page)
    const manyTemplates = Array.from({ length: 13 }, (_, i) => ({
      ...mockBasicLeaseTemplate,
      uuid: templateUuid(i),
      name: `Template ${i + 1}`,
    }));

    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json({
          status: "success",
          data: { result: manyTemplates, nextPageIdentifier: null },
        } as ApiResponse<ApiPaginatedResult<LeaseTemplateView>>);
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    // Wait for the first page to load
    await waitFor(() => {
      expect(screen.getByText("Template 1")).toBeInTheDocument();
    });

    // Navigate to the second page
    const pagination = createWrapper().findPagination();
    const nextPageButton = pagination?.findNextPageButton();
    await user.click(nextPageButton?.getElement() as HTMLElement);

    // Verify we're on page 2
    await waitFor(() => {
      expect(screen.getByText("Template 13")).toBeInTheDocument();
    });

    // Now search for something
    const searchInput = screen.getByPlaceholderText("Search by template name");
    // One change event, not one re-filter per typed character
    fireEvent.change(searchInput, { target: { value: "Template 1" } });

    // Should reset to page 1 and show filtered results
    await waitFor(() => {
      expect(screen.getByText("Template 1")).toBeInTheDocument();
      expect(screen.getByText("Template 10")).toBeInTheDocument();
    });
  });
});
