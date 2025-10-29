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
import { ReactNode, useState } from "react";

type RequestStatus = {
  status?: "loading" | "success" | "error";
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

export const BatchActionReview = <T extends Record<string, any>>({
  items,
  description,
  columnDefinitions,
  identifierKey,
  footer,
  onSubmit,
  onSuccess,
  onError,
}: BatchActionReviewProps<T>) => {
  const { hideModal } = useModal();
  const [requests, setRequests] = useState<Record<string, RequestStatus>>({});
  const [submissionIsLoading, setSubmissionIsLoading] =
    useState<boolean>(false);
  const [submitButtonText, setSubmitButtonText] = useState<string>("Submit");

  const itemsWithRequests = items.map(
    (item): ItemWithRequest<T> => ({
      ...item,
      request: requests[item[identifierKey]],
    }),
  );

  const onBatchSubmit = async () => {
    setSubmissionIsLoading(true);
    const responses = items.map(async (item: T) => {
      const itemId = item[identifierKey];

      if (requests[itemId] && requests[itemId]?.status !== "error") {
        return;
      }
      try {
        setRequests((prev) => ({
          ...prev,
          [itemId]: {
            status: "loading",
          },
        }));

        await onSubmit(item);

        setRequests((prev) => ({
          ...prev,
          [itemId]: { status: "success" },
        }));
      } catch (error) {
        if (error instanceof Error) {
          setRequests((prev) => ({
            ...prev,
            [itemId]: { status: "error", error },
          }));
        }
        throw error;
      }
    });
    try {
      await Promise.all(responses);
      hideModal();
      onSuccess();
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
