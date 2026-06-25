// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert, Box, KeyValuePairs } from "@cloudscape-design/components";
import { DateTime } from "luxon";

import { PendingExtensionRequest } from "@amzn/innovation-sandbox-commons/data/lease/lease";

interface PendingExtensionInfoProps {
  pendingExtensionRequest: PendingExtensionRequest;
}

export const PendingExtensionInfo = ({
  pendingExtensionRequest,
}: PendingExtensionInfoProps) => {
  return (
    <Alert type="info" header="Pending Extension Request">
      <KeyValuePairs
        columns={3}
        items={[
          {
            label: "Requested Expiration Date",
            value: DateTime.fromISO(
              pendingExtensionRequest.requestedExpirationDate,
            ).toLocaleString(DateTime.DATETIME_FULL),
          },
          {
            label: "Requested By",
            value: pendingExtensionRequest.requestedBy,
          },
          {
            label: "Requested At",
            value: DateTime.fromISO(
              pendingExtensionRequest.requestedAt,
            ).toLocaleString(DateTime.DATETIME_FULL),
          },
          ...(pendingExtensionRequest.comments
            ? [
                {
                  label: "Comments",
                  value: (
                    <Box variant="p">
                      {pendingExtensionRequest.comments}
                    </Box>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Alert>
  );
};
