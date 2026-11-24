// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert, Box, Button } from "@cloudscape-design/components";
import { useNavigate } from "react-router-dom";

interface ErrorPanelProps {
  header?: string;
  description?: string;
  retry?: () => void;
  error?: Error;
}

export const ErrorPanel = ({
  header = "Whoops, something went wrong.",
  description,
  retry,
  error,
}: ErrorPanelProps) => {
  const navigate = useNavigate();
  const reLogin = () => {
    navigate(0);
  };
  const sessionExpiredAlert = (
    <Alert type="error" header="Session expired">
      {description && <Box margin={{ top: "xs" }}>{description}</Box>}
      <Box margin={{ top: "s" }}>
        <Button iconName="refresh" onClick={reLogin}>
          Login Again
        </Button>
      </Box>
    </Alert>
  );
  const errorAlert = (
    <Alert type="error" header={header}>
      {description && <Box margin={{ top: "xs" }}>{description}</Box>}
      {retry && (
        <Box margin={{ top: "s" }}>
          <Button iconName="refresh" onClick={() => retry()}>
            Try again
          </Button>
        </Box>
      )}
    </Alert>
  );
  if (error?.toString().includes("403")) {
    return sessionExpiredAlert;
  } else {
    return errorAlert;
  }
};
