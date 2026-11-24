// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { TextFilter } from "@cloudscape-design/components";
import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import {
  FilterableColumnDefinition,
  FilterableTable,
} from "@amzn/innovation-sandbox-frontend/components/FilterableTable";

interface TestItem {
  id: string;
  name: string;
}

const items: TestItem[] = [
  { id: "1", name: "Alpha" },
  { id: "2", name: "Beta" },
  { id: "3", name: "Gamma" },
];

const columnDefinitions: FilterableColumnDefinition<TestItem>[] = [
  {
    id: "name",
    header: "Name",
    cell: (item) => item.name,
    sortingField: "name",
  },
];

const filteringProperties = [
  {
    key: "name",
    propertyLabel: "Name",
    groupValuesLabel: "Name values",
    operators: [":", "!:"],
  },
];

class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserver;

describe("FilterableTable", () => {
  test("locally paginates an eagerly loaded client collection", async () => {
    const user = userEvent.setup();

    render(
      <FilterableTable
        title="Client items"
        items={items}
        columnDefinitions={columnDefinitions}
        filteringProperties={filteringProperties}
        defaultPageSize={2}
        trackBy="id"
      />,
    );

    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.getByText("Beta")).toBeVisible();
    expect(screen.queryByText("Gamma")).not.toBeInTheDocument();

    await user.click(
      createWrapper().findPagination()!.findNextPageButton().getElement(),
    );

    expect(screen.getByText("Gamma")).toBeVisible();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  test("delegates pagination and page size in server mode", async () => {
    const onPageChange = vi.fn();
    const onPageSizeChange = vi.fn();
    const user = userEvent.setup();

    render(
      <FilterableTable
        collectionMode="server"
        title="Server items"
        items={[items[0]]}
        columnDefinitions={columnDefinitions}
        filter={
          <TextFilter
            filteringText=""
            filteringPlaceholder="Find server items"
            onChange={() => undefined}
          />
        }
        pageSize={20}
        pageSizeOptions={[
          { value: 20, label: "20 rows" },
          { value: 50, label: "50 rows" },
        ]}
        onPageSizeChange={onPageSizeChange}
        pagination={{
          currentPageIndex: 1,
          pagesCount: 1,
          openEnd: true,
          onChange: onPageChange,
          ariaLabels: {
            paginationLabel: "Custom server pagination",
          },
        }}
        counter="(1 loaded)"
        trackBy="id"
      />,
    );

    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.getByPlaceholderText("Find server items")).toBeVisible();
    expect(screen.getByLabelText("Custom server pagination")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Next page" }),
    ).toBeInTheDocument();

    const table = createWrapper().findTable()!;
    await user.click(table.findPagination()!.findNextPageButton().getElement());
    expect(onPageChange).toHaveBeenCalledWith(2);

    const preferences = table.findCollectionPreferences()!;
    await user.click(preferences.findTriggerButton().getElement());
    const modal = preferences.findModal()!;
    const fiftyRows = modal
      .findPageSizePreference()!
      .findOptions()
      .find((option) =>
        option.findLabel().getElement().textContent?.includes("50 rows"),
      )!;
    await user.click(fiftyRows.findNativeInput().getElement());
    await user.click(modal.findConfirmButton()!.getElement());

    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  test("applies client defaults when switching from server mode", async () => {
    const { rerender } = render(
      <FilterableTable
        collectionMode="server"
        title="Items"
        items={items}
        columnDefinitions={columnDefinitions}
        pageSize={20}
        onPageSizeChange={() => undefined}
        trackBy="id"
      />,
    );

    rerender(
      <FilterableTable
        collectionMode="client"
        title="Items"
        items={items}
        columnDefinitions={columnDefinitions}
        filteringProperties={filteringProperties}
        defaultPageSize={1}
        defaultFilteringQuery={{
          tokens: [
            {
              propertyKey: "name",
              operator: "!:",
              value: "Beta",
            },
          ],
          operation: "and",
        }}
        trackBy="id"
      />,
    );

    await waitFor(() => expect(screen.getByText("(2/3)")).toBeVisible());
    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
    expect(screen.queryByText("Gamma")).not.toBeInTheDocument();
  });
});
