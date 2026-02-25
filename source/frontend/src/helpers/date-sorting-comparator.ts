// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const createDateSortingComparator = <T>(
  getDate: (item: T) => string | undefined,
) => {
  return (a: T, b: T) => {
    const aDate = getDate(a);
    const bDate = getDate(b);

    if (!aDate && !bDate) return 0;
    if (!aDate) return 1;
    if (!bDate) return -1;

    return aDate.localeCompare(bDate);
  };
};
