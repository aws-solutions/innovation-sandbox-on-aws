// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { BlueprintTable } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/BlueprintTable";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import {
  createBlueprint,
  createBlueprintWithStackSets,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/blueprintFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";

// Mock ResizeObserver
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;

// Mock the useUser hook
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => ({
    isAdmin: true,
    isManager: false,
    isUser: false,
  }),
}));

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

describe("BlueprintTable - Unregister cache invalidation", () => {
  const blueprint1 = createBlueprintWithStackSets({
    blueprint: createBlueprint({
      name: "Blueprint-1",
      blueprintId: "00000000-0000-0000-0000-000000000001",
    }),
  });
  const blueprint2 = createBlueprintWithStackSets({
    blueprint: createBlueprint({
      name: "Blueprint-2",
      blueprintId: "00000000-0000-0000-0000-000000000002",
    }),
  });

  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;

  const renderComponent = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <ModalProvider>
          <BrowserRouter>
            <BlueprintTable />
          </BrowserRouter>
        </ModalProvider>
      </QueryClientProvider>,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  });

  const countBlueprintInvalidations = () =>
    invalidateSpy.mock.calls.filter((call: unknown[]) => {
      const arg = call[0] as {
        queryKey?: string[];
        refetchType?: string;
      };
      return (
        arg?.queryKey?.[0] === "blueprints" &&
        arg?.queryKey?.length === 1 &&
        arg?.refetchType === "all"
      );
    }).length;

  test("onSuccess callback invalidates blueprint query cache after successful unregister", async () => {
    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [blueprint1],
            nextPageIdentifier: null,
          },
        });
      }),
      http.delete(`${config.ApiUrl}/blueprints/:id`, () => {
        return HttpResponse.json({ status: "success", data: {} });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Blueprint-1")).toBeInTheDocument();
    });

    invalidateSpy.mockClear();

    // Select the blueprint
    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const selectAllCheckbox = table!.findSelectAllTrigger();
    await user.click(selectAllCheckbox!.getElement());

    // Open Actions dropdown and click Unregister
    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);
    const unregisterOption = await screen.findByText("Unregister");
    await user.click(unregisterOption);

    // Submit the unregister
    const modal = screen.getByRole("dialog");
    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await user.click(submitButton);

    // Wait for batch to complete — the onSuccess callback fires after
    // hideModal(), so we wait for the invalidation to confirm completion.
    await waitFor(() => {
      const invalidationCount = countBlueprintInvalidations();
      expect(invalidationCount).toBeGreaterThanOrEqual(1);
    });

    // Verify the success toast was shown
    expect(showSuccessToast).toHaveBeenCalledWith(
      "Blueprint unregistered successfully",
    );
  });

  test("partial failure shows only failed items on retry via per-item selection filtering", async () => {
    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [blueprint1, blueprint2],
            nextPageIdentifier: null,
          },
        });
      }),
      // Blueprint-1 deletes successfully, blueprint-2 fails
      http.delete(`${config.ApiUrl}/blueprints/:id`, ({ params }) => {
        if (params.id === blueprint2.blueprint.blueprintId) {
          return HttpResponse.json(
            { status: "error", message: "Failed to delete" },
            { status: 500 },
          );
        }
        return HttpResponse.json({ status: "success", data: {} });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    // Wait for table to load with both blueprints
    await waitFor(() => {
      expect(screen.getByText("Blueprint-1")).toBeInTheDocument();
      expect(screen.getByText("Blueprint-2")).toBeInTheDocument();
    });

    // Select all blueprints
    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const selectAllCheckbox = table!.findSelectAllTrigger();
    await user.click(selectAllCheckbox!.getElement());

    // Open Actions dropdown and click Unregister
    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);
    const unregisterOption = await screen.findByText("Unregister");
    await user.click(unregisterOption);

    // Submit the unregister (1 succeeds, 1 fails)
    const modal = screen.getByRole("dialog");
    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await user.click(submitButton);

    // Wait for the batch to complete — blueprint-2 should show "Failed"
    await waitFor(() => {
      expect(within(modal).getByText("Failed")).toBeInTheDocument();
    });

    // Blueprint-1 should show "Success" in the modal
    expect(within(modal).getByText("Success")).toBeInTheDocument();

    // Close the modal
    const cancelButton = within(modal).getByRole("button", {
      name: /Cancel/i,
    });
    await user.click(cancelButton);

    // After closing, the table's selectedItems should only contain
    // the failed blueprint (blueprint-2), not the successful one.
    await waitFor(() => {
      const tableElement = wrapper.findTable();
      const selectedRows = tableElement!.findSelectedRows();
      expect(selectedRows).toHaveLength(1);
      // Verify it's specifically Blueprint-2 (the failed one) that remains selected
      expect(selectedRows[0].getElement().textContent).toContain("Blueprint-2");
    });
  });

  test("onError callback invalidates blueprint query cache on partial failure", async () => {
    server.use(
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [blueprint1, blueprint2],
            nextPageIdentifier: null,
          },
        });
      }),
      // Blueprint-1 succeeds, blueprint-2 fails
      http.delete(`${config.ApiUrl}/blueprints/:id`, ({ params }) => {
        if (params.id === blueprint2.blueprint.blueprintId) {
          return HttpResponse.json(
            { status: "error", message: "Failed to delete" },
            { status: 500 },
          );
        }
        return HttpResponse.json({ status: "success", data: {} });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText("Blueprint-1")).toBeInTheDocument();
      expect(screen.getByText("Blueprint-2")).toBeInTheDocument();
    });

    invalidateSpy.mockClear();

    // Select all blueprints
    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const selectAllCheckbox = table!.findSelectAllTrigger();
    await user.click(selectAllCheckbox!.getElement());

    // Open Actions dropdown and click Unregister
    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);
    const unregisterOption = await screen.findByText("Unregister");
    await user.click(unregisterOption);

    // Submit the unregister (partial failure)
    const modal = screen.getByRole("dialog");
    const submitButton = within(modal).getByRole("button", {
      name: /Submit/i,
    });
    await user.click(submitButton);

    // Wait for the batch to complete with partial failure
    await waitFor(() => {
      expect(within(modal).getByText("Failed")).toBeInTheDocument();
    });

    // onError should still invalidate the cache so the list refreshes
    // to reflect the successfully unregistered items
    await waitFor(() => {
      const invalidationCount = countBlueprintInvalidations();
      expect(invalidationCount).toBeGreaterThanOrEqual(1);
    });

    // Verify the error toast was shown
    expect(showErrorToast).toHaveBeenCalledWith(
      "One or more blueprints failed to unregister. Try resubmitting.",
      "Unregister failed",
    );
  });
});
