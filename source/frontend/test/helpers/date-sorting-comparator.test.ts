// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createDateSortingComparator } from "../../src/helpers/date-sorting-comparator";

describe("createDateSortingComparator", () => {
  interface TestItem {
    id: string;
    date?: string;
  }

  it("should sort items by date in ascending order", () => {
    const comparator = createDateSortingComparator<TestItem>(
      (item) => item.date,
    );
    const items: TestItem[] = [
      { id: "1", date: "2024-12-31T23:59:59Z" },
      { id: "2", date: "2024-01-01T00:00:00Z" },
      { id: "3", date: "2024-06-15T12:00:00Z" },
      { id: "4", date: "2024-03-20T08:30:00Z" },
    ];

    const sorted = [...items].sort(comparator);

    expect(sorted.map((item) => item.id)).toEqual(["2", "4", "3", "1"]);
  });

  it("should sort items with dates across different years", () => {
    const comparator = createDateSortingComparator<TestItem>(
      (item) => item.date,
    );
    const items: TestItem[] = [
      { id: "1", date: "2025-01-01T00:00:00Z" },
      { id: "2", date: "2023-12-31T23:59:59Z" },
      { id: "3", date: "2024-06-15T12:00:00Z" },
    ];

    const sorted = [...items].sort(comparator);

    expect(sorted.map((item) => item.id)).toEqual(["2", "3", "1"]);
  });

  it("should sort items with same date but different times", () => {
    const comparator = createDateSortingComparator<TestItem>(
      (item) => item.date,
    );
    const items: TestItem[] = [
      { id: "1", date: "2024-06-15T23:59:59Z" },
      { id: "2", date: "2024-06-15T00:00:00Z" },
      { id: "3", date: "2024-06-15T12:00:00Z" },
    ];

    const sorted = [...items].sort(comparator);

    expect(sorted.map((item) => item.id)).toEqual(["2", "3", "1"]);
  });

  it("should place items with undefined dates at the end", () => {
    const comparator = createDateSortingComparator<TestItem>(
      (item) => item.date,
    );
    const items: TestItem[] = [
      { id: "1", date: "2024-12-31T23:59:59Z" },
      { id: "2" },
      { id: "3", date: "2024-01-01T00:00:00Z" },
      { id: "4" },
      { id: "5", date: "2024-06-15T12:00:00Z" },
    ];

    const sorted = [...items].sort(comparator);

    expect(sorted[0].id).toBe("3");
    expect(sorted[1].id).toBe("5");
    expect(sorted[2].id).toBe("1");
    expect(sorted[3].date).toBeUndefined();
    expect(sorted[4].date).toBeUndefined();
  });

  it("should handle single item array", () => {
    const comparator = createDateSortingComparator<TestItem>(
      (item) => item.date,
    );
    const items: TestItem[] = [{ id: "1", date: "2024-06-15T12:00:00Z" }];

    const sorted = [...items].sort(comparator);

    expect(sorted.length).toBe(1);
    expect(sorted[0].id).toBe("1");
  });

  it("should handle empty array", () => {
    const comparator = createDateSortingComparator<TestItem>(
      (item) => item.date,
    );
    const items: TestItem[] = [];

    const sorted = [...items].sort(comparator);

    expect(sorted.length).toBe(0);
  });

  it("should handle already sorted array", () => {
    const comparator = createDateSortingComparator<TestItem>(
      (item) => item.date,
    );
    const items: TestItem[] = [
      { id: "1", date: "2024-01-01T00:00:00Z" },
      { id: "2", date: "2024-06-15T12:00:00Z" },
      { id: "3", date: "2024-12-31T23:59:59Z" },
    ];

    const sorted = [...items].sort(comparator);

    expect(sorted.map((item) => item.id)).toEqual(["1", "2", "3"]);
  });
});
