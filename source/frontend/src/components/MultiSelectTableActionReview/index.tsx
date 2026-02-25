// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  Popover,
  SpaceBetween,
  StatusIndicator,
  Table,
  TableProps,
} from "@cloudscape-design/components";

import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { ReactNode, useMemo, useState } from "react";

type RequestStatus = {
  status?: "pending" | "loading" | "success" | "error";
  error?: Error;
};

type ProcessResult = {
  success: boolean;
  error?: Error;
};

type ItemWithRequest<T> = {
  request?: RequestStatus;
} & T;

type BatchActionReviewProps<T> = {
  items: T[];
  description?: string;
  columnDefinitions: TableProps.ColumnDefinition<T>[];
  identifierKey: keyof T;
  footer?: ReactNode;
  sequential?: boolean;
  onSubmit: (item: T) => Promise<any>;
  onSuccess: () => void;
  onError: (error: any) => void;
};

const StatusCell = <T extends Record<string, any>>({
  item,
}: {
  item: ItemWithRequest<T>;
}) => {
  switch (item.request?.status) {
    case "pending":
      return <StatusIndicator type="pending">Pending</StatusIndicator>;
    case "loading":
      return <StatusIndicator type="loading">Loading</StatusIndicator>;
    case "success":
      return <StatusIndicator type="success">Success</StatusIndicator>;
    case "error":
      return (
        <StatusIndicator type="error">
          <Popover
            content={item.request?.error?.message}
            dismissButton={false}
            position="top"
          >
            Failed
          </Popover>
        </StatusIndicator>
      );
    default:
      return null;
  }
};

const initializePendingRequests = <T extends Record<string, any>>(
  items: T[],
  requests: Record<string, RequestStatus>,
  identifierKey: keyof T,
): Record<string, RequestStatus> => {
  const updatedRequests = { ...requests };
  items.forEach((item) => {
    const itemId = item[identifierKey];
    const currentStatus = requests[itemId]?.status;
    if (!currentStatus || currentStatus === "error") {
      updatedRequests[itemId] = { status: "pending" };
    }
  });
  return updatedRequests;
};

const processItemsSequentially = async <T extends Record<string, any>>(
  items: T[],
  processItem: (item: T) => Promise<ProcessResult>,
): Promise<ProcessResult> => {
  let hasErrors = false;
  for (const item of items) {
    const result = await processItem(item);
    hasErrors = hasErrors || !result.success;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { success: !hasErrors };
};

const processItemsInParallel = async <T extends Record<string, any>>(
  items: T[],
  processItem: (item: T) => Promise<ProcessResult>,
): Promise<ProcessResult> => {
  const results = await Promise.all(items.map(processItem));
  return { success: results.every((result) => result.success) };
};

export const BatchActionReview = <T extends Record<string, any>>({
  items,
  description,
  columnDefinitions,
  identifierKey,
  footer,
  sequential = false,
  onSubmit,
  onSuccess,
  onError,
}: BatchActionReviewProps<T>) => {
  const { hideModal } = useModal();
  const [requests, setRequests] = useState<Record<string, RequestStatus>>({});
  const [submissionIsLoading, setSubmissionIsLoading] =
    useState<boolean>(false);
  const [submitButtonText, setSubmitButtonText] = useState<string>("Submit");

  const itemsWithRequests = useMemo(
    () =>
      items.map(
        (item): ItemWithRequest<T> => ({
          ...item,
          request: requests[item[identifierKey]],
        }),
      ),
    [items, requests, identifierKey],
  );

  const processItem = async (item: T): Promise<ProcessResult> => {
    const itemId = item[identifierKey];
    const updatedRequests = initializePendingRequests(
      items,
      requests,
      identifierKey,
    );

    // Skip items that already succeeded or are currently loading
    if (
      updatedRequests[itemId]?.status === "success" ||
      updatedRequests[itemId]?.status === "loading"
    ) {
      return { success: true };
    }

    try {
      setRequests((prev) => ({
        ...prev,
        [itemId]: { status: "loading" },
      }));

      await onSubmit(item);

      setRequests((prev) => ({
        ...prev,
        [itemId]: { status: "success" },
      }));

      return { success: true };
    } catch (error) {
      if (error instanceof Error) {
        setRequests((prev) => ({
          ...prev,
          [itemId]: { status: "error", error },
        }));
        return { success: false, error };
      }
      return { success: false };
    }
  };

  const onBatchSubmit = async () => {
    setSubmissionIsLoading(true);

    const updatedRequests = initializePendingRequests(
      items,
      requests,
      identifierKey,
    );
    setRequests(updatedRequests);

    try {
      const result = sequential
        ? await processItemsSequentially(items, processItem)
        : await processItemsInParallel(items, processItem);

      if (result.success) {
        hideModal();
        onSuccess();
      } else {
        throw new Error("Some items failed to process");
      }
    } catch (error) {
      setSubmissionIsLoading(false);
      setSubmitButtonText("Retry");
      onError(error);
    }
  };

  return (
    <Box>
      <SpaceBetween size="l">
        {description && (
          <Box variant="p" color="text-label">
            {description}
          </Box>
        )}
        <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
          <Table
            items={itemsWithRequests}
            trackBy={identifierKey as string}
            stripedRows
            variant="borderless"
            sortingDisabled
            stickyHeader
            columnDefinitions={[
              ...columnDefinitions,
              {
                header: "Status",
                id: "Status",
                minWidth: 120,
                cell: (item: ItemWithRequest<T>) => <StatusCell item={item} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
              },
            ]}
          />
        </div>
        {footer && <Box>{footer}</Box>}
        <Box float="right">
          <Button variant="link" onClick={hideModal}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={submissionIsLoading}
            onClick={onBatchSubmit}
          >
            {submitButtonText}
          </Button>
        </Box>
      </SpaceBetween>
    </Box>
  );
};
