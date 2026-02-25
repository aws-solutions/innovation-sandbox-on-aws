// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ContentLayout as CloudscapeContentLayout,
  ContentLayoutProps as CloudscapeContentLayoutProps,
} from "@cloudscape-design/components";

const MAX_CONTENT_WIDTH = 1620;

interface ContentLayoutProps extends Omit<
  CloudscapeContentLayoutProps,
  "defaultPadding" | "maxContentWidth"
> {
  /**
   * Whether to apply default padding and max content width.
   * Set to false for full-width table pages.
   * @default true
   */
  disablePadding?: boolean;
}

/**
 * Wrapper component for ContentLayout that applies consistent padding and max width.
 * Use this for all pages to ensure consistent formatting across loading, error, and success states.
 */
export const ContentLayout = (props: ContentLayoutProps) => {
  return (
    <CloudscapeContentLayout
      {...props}
      defaultPadding
      maxContentWidth={props.disablePadding ? undefined : MAX_CONTENT_WIDTH}
    />
  );
};
