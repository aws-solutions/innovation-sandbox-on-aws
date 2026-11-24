// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useRef } from "react";

/**
 * Returns a stable ref whose current value is refreshed on every render.
 * Useful when asynchronous callbacks need the latest prop or state value.
 */
export const useLatest = <T>(value: T) => {
  const ref = useRef(value);
  ref.current = value;
  return ref;
};
