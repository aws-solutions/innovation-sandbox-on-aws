// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export type PaginatedQueryResult<T> = {
  error?: string;
  result: T[];
  nextPageIdentifier: string | null;
};

export type PutResult<T> = {
  oldItem?: Record<string, any>;
  newItem: T;
};

export type SingleItemResult<T> = {
  error?: string;
  result?: T;
};

export type OptionalItem = Record<string, any> | undefined;
