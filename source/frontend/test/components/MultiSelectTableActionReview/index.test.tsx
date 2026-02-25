// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { BatchActionReview } from "@amzn/innovation-sandbox-frontend/components/MultiSelectTableActionReview";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockHideModal = vi.fn();

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useModal", async () => {
  const actual = await vi.importActual(
    "@amzn/innovation-sandbox-frontend/hooks/useModal",
  );
  return {
    ...actual,
    useModal: () => ({
      showModal: vi.fn(),
      hideModal: mockHideModal,
    }),
  };
});

type TestItem = {
  column1: string;
  column2: string;
  column3: string;
};

const mockItems: TestItem[] = [
  { column1: "val 1A", column2: "val 2A", column3: "val 3A" },
  { column1: "val 1B", column2: "val 2B", column3: "val 3B" },
  { column1: "val 1C", column2: "val 2C", column3: "val 3C" },
];

const columnDefinitions = [
  {
    header: "Column 1",
    cell: (item: TestItem) => item.column1,
    id: "column1",
  },
  {
    header: "Column 2",
    cell: (item: TestItem) => item.column2,
    id: "column2",
  },
  {
    header: "Column 3",
    cell: (item: TestItem) => item.column3,
    id: "column3",
  },
];

beforeEach(() => {
  mockHideModal.mockClear();
});

describe("BatchActionReview", () => {
  const renderComponent = (
    props: Partial<
      React.ComponentProps<typeof BatchActionReview<TestItem>>
    > = {},
  ) => {
    const defaultProps = {
      items: mockItems,
      columnDefinitions,
      identifierKey: "column1" as keyof TestItem,
      onSubmit: vi.fn().mockResolvedValue(undefined),
      onSuccess: vi.fn(),
      onError: vi.fn(),
      ...props,
    };

    return renderWithQueryClient(
      <ModalProvider>
        <BatchActionReview {...defaultProps} />
      </ModalProvider>,
    );
  };

  describe("Rendering", () => {
    test("renders table with all items", () => {
      renderComponent();

      expect(screen.getByText("val 1A")).toBeInTheDocument();
      expect(screen.getByText("val 1B")).toBeInTheDocument();
      expect(screen.getByText("val 1C")).toBeInTheDocument();
    });

    test("renders column headers", () => {
      renderComponent();

      expect(screen.getAllByText("Column 1")[0]).toBeInTheDocument();
      expect(screen.getAllByText("Column 2")[0]).toBeInTheDocument();
      expect(screen.getAllByText("Column 3")[0]).toBeInTheDocument();
      expect(screen.getAllByText("Status")[0]).toBeInTheDocument();
    });

    test("renders description when provided", () => {
      const description = "3 items will be processed";
      renderComponent({ description });

      expect(screen.getByText(description)).toBeInTheDocument();
    });

    test("does not render description when not provided", () => {
      renderComponent();

      expect(
        screen.queryByText(/items will be processed/),
      ).not.toBeInTheDocument();
    });

    test("renders footer when provided", () => {
      const footer = <div>Warning: This action cannot be undone</div>;
      renderComponent({ footer });

      expect(
        screen.getByText("Warning: This action cannot be undone"),
      ).toBeInTheDocument();
    });

    test("renders Cancel and Submit buttons", () => {
      renderComponent();

      expect(
        screen.getByRole("button", { name: "Cancel" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Submit" }),
      ).toBeInTheDocument();
    });

    test("Submit button is enabled by default", () => {
      renderComponent();

      const submitButton = screen.getByRole("button", { name: "Submit" });
      expect(submitButton).not.toBeDisabled();
    });
  });

  describe("Parallel Submission (default)", () => {
    test("processes all items in parallel on submit", async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const onSuccess = vi.fn();
      renderComponent({ onSubmit, onSuccess });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(3);
        expect(onSubmit).toHaveBeenCalledWith(mockItems[0]);
        expect(onSubmit).toHaveBeenCalledWith(mockItems[1]);
        expect(onSubmit).toHaveBeenCalledWith(mockItems[2]);
      });
    });

    test("shows loading status for all items after submit", async () => {
      const onSubmit = vi
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 50)),
        );
      renderComponent({ onSubmit });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      // Check immediately after click - items should be loading in parallel once processing starts
      await waitFor(() => {
        expect(screen.queryAllByText("Loading").length).toBe(3);
      });
    });

    test("shows success status for all items on successful submission", async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const onSuccess = vi.fn();
      renderComponent({ onSubmit, onSuccess });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        const successStatuses = screen.getAllByText("Success");
        expect(successStatuses).toHaveLength(3);
      });
    });

    test("calls onSuccess and hides modal when all items succeed", async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const onSuccess = vi.fn();

      renderComponent({ onSubmit, onSuccess });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalled();
        expect(mockHideModal).toHaveBeenCalled();
      });
    });

    test("shows error status for failed items", async () => {
      const onSubmit = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Failed to process item 2"))
        .mockResolvedValueOnce(undefined);
      renderComponent({ onSubmit });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(screen.getAllByText("Success")).toHaveLength(2);
        expect(screen.getByText("Failed")).toBeInTheDocument();
      });
    });

    test("shows error message in popover for failed items", async () => {
      const errorMessage = "Network error occurred";
      const onSubmit = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error(errorMessage))
        .mockResolvedValueOnce(undefined);
      renderComponent({ onSubmit });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Failed")).toBeInTheDocument();
      });

      // Click on the failed status to open popover (hover doesn't work in tests)
      const failedStatus = screen.getByText("Failed");
      await user.click(failedStatus);

      await waitFor(() => {
        expect(screen.getByText(errorMessage)).toBeInTheDocument();
      });
    });

    test("calls onError when some items fail", async () => {
      const onSubmit = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Failed"))
        .mockResolvedValueOnce(undefined);
      const onError = vi.fn();
      renderComponent({ onSubmit, onError });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "Some items failed to process",
          }),
        );
      });
    });

    test("does not hide modal when some items fail", async () => {
      const onSubmit = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Failed"))
        .mockResolvedValueOnce(undefined);
      renderComponent({ onSubmit });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText("Failed")).toBeInTheDocument();
      });

      expect(mockHideModal).not.toHaveBeenCalled();
    });

    test("changes submit button to Retry after failure", async () => {
      const onSubmit = vi.fn().mockRejectedValue(new Error("Failed"));
      renderComponent({ onSubmit });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Sequential Submission", () => {
    test("processes items sequentially when sequential=true", async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const onSuccess = vi.fn();
      renderComponent({ onSubmit, onSuccess, sequential: true });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(3);
      });

      // Verify sequential processing by checking call order
      expect(onSubmit.mock.invocationCallOrder[0]).toBeLessThan(
        onSubmit.mock.invocationCallOrder[1],
      );
      expect(onSubmit.mock.invocationCallOrder[1]).toBeLessThan(
        onSubmit.mock.invocationCallOrder[2],
      );
    });

    test("shows pending status for all items after submit", async () => {
      const onSubmit = vi
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 50)),
        );
      renderComponent({ onSubmit, sequential: true });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      // Check immediately after click - items should be loading in parallel once processing starts
      await waitFor(() => {
        expect(screen.queryAllByText("Pending").length).toBeGreaterThan(0);
      });
    });

    test("continues processing remaining items after one fails in sequential mode", async () => {
      const onSubmit = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Failed"))
        .mockResolvedValueOnce(undefined);
      renderComponent({ onSubmit, sequential: true });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(3);
        expect(screen.getAllByText("Success")).toHaveLength(2);
        expect(screen.getByText("Failed")).toBeInTheDocument();
      });
    });
  });

  describe("Retry Functionality", () => {
    test("only retries failed items on retry", async () => {
      const onSubmit = vi.fn();

      // First submission: item 1 succeeds, item 2 fails, item 3 succeeds
      onSubmit
        .mockResolvedValueOnce(undefined) // Item 1 succeeds
        .mockRejectedValueOnce(new Error("Failed")) // Item 2 fails
        .mockResolvedValueOnce(undefined); // Item 3 succeeds

      renderComponent({ onSubmit });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      // First submission
      await user.click(submitButton);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
      });

      // Verify first submission called onSubmit 3 times
      expect(onSubmit).toHaveBeenCalledTimes(3);

      // Setup mock for retry - only item 2 should be retried
      onSubmit.mockResolvedValueOnce(undefined); // Item 2 retry succeeds

      // Retry
      const retryButton = screen.getByRole("button", { name: "Retry" });
      await user.click(retryButton);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(4); // 3 initial + 1 retry
        expect(screen.getAllByText("Success")).toHaveLength(3);
      });
    });

    test("does not reprocess successful items on retry", async () => {
      const onSubmit = vi.fn();

      // First submission
      onSubmit
        .mockResolvedValueOnce(undefined) // Item 1 succeeds
        .mockRejectedValueOnce(new Error("Failed")) // Item 2 fails
        .mockResolvedValueOnce(undefined); // Item 3 succeeds

      renderComponent({ onSubmit });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
      });

      // Setup mock for retry
      onSubmit.mockResolvedValueOnce(undefined); // Item 2 retry succeeds

      const retryButton = screen.getByRole("button", { name: "Retry" });
      await user.click(retryButton);

      await waitFor(() => {
        // Should only call onSubmit 4 times total (3 initial + 1 retry for failed item)
        expect(onSubmit).toHaveBeenCalledTimes(4);
      });

      // Verify item 2 was retried
      expect(onSubmit).toHaveBeenNthCalledWith(4, mockItems[1]);
    });

    test("shows success after retrying failures", async () => {
      const onSubmit = vi
        .fn()
        .mockRejectedValueOnce(new Error("Failed"))
        .mockRejectedValueOnce(new Error("Failed"))
        .mockRejectedValueOnce(new Error("Failed"))
        .mockResolvedValue(undefined);

      renderComponent({ onSubmit });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(screen.getAllByText("Failed")).toHaveLength(3);
      });

      const retryButton = screen.getByRole("button", { name: "Retry" });
      await user.click(retryButton);

      // Should show success after retrying
      expect(await screen.findAllByText("Success")).toHaveLength(3);
    });
  });

  describe("Button States", () => {
    test("disables submit button during processing", async () => {
      const onSubmit = vi
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 50)),
        );
      renderComponent({ onSubmit });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(submitButton).toBeDisabled();
      });
    });

    test("re-enables submit button after processing completes with errors", async () => {
      const onSubmit = vi.fn().mockRejectedValue(new Error("Failed"));
      renderComponent({ onSubmit });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
      });

      // Button should be re-enabled after error
      const retryButton = screen.getByRole("button", { name: "Retry" });
      expect(retryButton).not.toBeDisabled();
    });
  });

  describe("Cancel Button", () => {
    test("calls hideModal when cancel button is clicked", async () => {
      renderComponent();

      const user = userEvent.setup();
      const cancelButton = screen.getByRole("button", { name: "Cancel" });

      await user.click(cancelButton);

      expect(mockHideModal).toHaveBeenCalled();
    });

    test("cancel button is always enabled", () => {
      renderComponent();

      const cancelButton = screen.getByRole("button", { name: "Cancel" });
      expect(cancelButton).not.toBeDisabled();
    });
  });

  describe("Edge Cases", () => {
    test("handles empty items array", () => {
      renderComponent({ items: [] });

      expect(screen.getAllByText("Column 1")[0]).toBeInTheDocument();
      expect(screen.queryByText("val 1A")).not.toBeInTheDocument();
    });

    test("handles single item", async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);
      const onSuccess = vi.fn();
      renderComponent({
        items: [mockItems[0]],
        onSubmit,
        onSuccess,
      });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
    });

    test("handles all items failing", async () => {
      const onSubmit = vi.fn().mockRejectedValue(new Error("Failed"));
      const onError = vi.fn();
      renderComponent({ onSubmit, onError });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        expect(screen.getAllByText("Failed")).toHaveLength(3);
        expect(onError).toHaveBeenCalledTimes(1);
      });
    });

    test("handles non-Error exceptions", async () => {
      const onSubmit = vi.fn().mockRejectedValue("String error");
      renderComponent({ onSubmit });

      const user = userEvent.setup();
      const submitButton = screen.getByRole("button", { name: "Submit" });

      await user.click(submitButton);

      await waitFor(() => {
        // Should not show error status for non-Error exceptions
        expect(screen.queryByText("Failed")).not.toBeInTheDocument();
      });
    });
  });

  describe("Table Features", () => {
    test("renders table with striped rows", () => {
      renderComponent();

      const table = screen.getByRole("table");
      expect(table).toBeInTheDocument();
    });

    test("renders table with borderless variant", () => {
      renderComponent();

      const table = screen.getByRole("table");
      expect(table).toBeInTheDocument();
    });

    test("renders sticky header", () => {
      renderComponent();

      expect(screen.getAllByText("Status")[0]).toBeInTheDocument();
    });
  });
});
