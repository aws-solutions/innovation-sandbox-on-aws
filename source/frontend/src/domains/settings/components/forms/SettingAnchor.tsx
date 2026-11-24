// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box } from "@cloudscape-design/components";
import type { ReactNode } from "react";

/** A stable search/deep-link target around an explicitly rendered field. */
export function SettingAnchor({
  id,
  children,
}: Readonly<{
  id: string;
  children: ReactNode;
}>) {
  return <Box nativeAttributes={{ id, tabIndex: -1 }}>{children}</Box>;
}
