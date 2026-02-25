// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Spinner } from "@cloudscape-design/components";

interface FullPageLoaderProps {
  label?: string;
}

export const FullPageLoader = ({
  label = "Loading...",
}: FullPageLoaderProps) => {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
      }}
    >
      <Spinner size="large" />
      <Box variant="p" margin={{ top: "s" }}>
        {label}
      </Box>
    </div>
  );
};
