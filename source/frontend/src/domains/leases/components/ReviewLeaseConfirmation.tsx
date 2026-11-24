// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Button } from "@cloudscape-design/components";
import { useNavigate } from "react-router-dom";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { useReviewLease } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";

export const ReviewLeaseConfirmation = ({
  mode,
  leaseId,
  onCancel,
}: {
  mode: "approve" | "deny";
  leaseId: string;
  onCancel: () => any;
}) => {
  const { mutateAsync: reviewLease, isPending: reviewLeaseIsLoading } =
    useReviewLease();
  const navigate = useNavigate();

  return (
    <Box>
      {`Are you sure you want to ${mode} the request?`}
      <Box textAlign="right" padding={{ top: "m" }}>
        <Button variant="link" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          loading={reviewLeaseIsLoading}
          onClick={() => {
            reviewLease(
              {
                leaseId,
                approve: mode === "approve",
              },
              {
                onSuccess: () => {
                  onCancel();
                  navigate("/approvals");
                  showSuccessToast(
                    mode === "approve"
                      ? "Request approved."
                      : "Request denied.",
                  );
                },
                onError: (error: any) => {
                  if (error instanceof Error) {
                    showErrorToast(error.message);
                  }
                },
              },
            );
          }}
        >
          Confirm
        </Button>
      </Box>
    </Box>
  );
};
