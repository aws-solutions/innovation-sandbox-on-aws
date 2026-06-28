// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  FormField,
  SpaceBetween,
  Textarea,
} from "@cloudscape-design/components";
import { DateTime } from "luxon";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { useReviewLeaseExtension } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { PendingExtensionRequest } from "@amzn/innovation-sandbox-commons/data/lease/lease";

interface ReviewExtensionConfirmationProps {
  mode: "approve" | "deny";
  leaseId: string;
  pendingExtensionRequest: PendingExtensionRequest;
  onCancel: () => void;
}

export const ReviewExtensionConfirmation = ({
  mode,
  leaseId,
  pendingExtensionRequest,
  onCancel,
}: ReviewExtensionConfirmationProps) => {
  const { mutateAsync: reviewExtension, isPending } =
    useReviewLeaseExtension();
  const navigate = useNavigate();
  const [comments, setComments] = useState("");

  return (
    <Box>
      <SpaceBetween size="m">
        <Box>
          {mode === "approve"
            ? "Are you sure you want to approve this extension request?"
            : "Are you sure you want to deny this extension request?"}
        </Box>

        <SpaceBetween size="xs">
          <Box variant="awsui-key-label">Requested Expiration Date</Box>
          <Box>
            {DateTime.fromISO(
              pendingExtensionRequest.requestedExpirationDate,
            ).toLocaleString(DateTime.DATETIME_FULL)}
          </Box>
        </SpaceBetween>

        {pendingExtensionRequest.comments && (
          <SpaceBetween size="xs">
            <Box variant="awsui-key-label">Requester Comments</Box>
            <Box>{pendingExtensionRequest.comments}</Box>
          </SpaceBetween>
        )}

        <SpaceBetween size="xs">
          <Box variant="awsui-key-label">Requested By</Box>
          <Box>{pendingExtensionRequest.requestedBy}</Box>
        </SpaceBetween>

        {mode === "deny" && (
          <FormField
            label={
              <>
                Denial Comments - <i>Optional</i>
              </>
            }
            description="Provide a reason for denying the extension request"
            constraintText={`Maximum 1000 characters. ${comments.length}/1000`}
            errorText={
              comments.length > 1000
                ? "Comments must be 1000 characters or fewer"
                : undefined
            }
          >
            <Textarea
              value={comments}
              onChange={({ detail }) => setComments(detail.value.slice(0, 1000))}
              placeholder="Reason for denial"
              ariaLabel="Denial comments"
            />
          </FormField>
        )}

        <Box textAlign="right" padding={{ top: "m" }}>
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onCancel} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={isPending}
              onClick={() => {
                reviewExtension(
                  {
                    leaseId,
                    action: mode === "approve" ? "Approve" : "Deny",
                    comments: mode === "deny" ? comments || undefined : undefined,
                  },
                  {
                    onSuccess: () => {
                      onCancel();
                      navigate("/approvals");
                      showSuccessToast(
                        mode === "approve"
                          ? "Extension request approved."
                          : "Extension request denied.",
                      );
                    },
                    onError: (error: unknown) => {
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
          </SpaceBetween>
        </Box>
      </SpaceBetween>
    </Box>
  );
};
