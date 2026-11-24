// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Duration } from "luxon";

import { getPermissionSetService } from "./service";

export const PERMISSION_SETS_QUERY_KEY = "permissionSets";
export const PERMISSION_SETS_PAGE_SIZE = 20;
export const PERMISSION_SETS_QUERY_MAX_LENGTH = 200;
const PERMISSION_SETS_STALE_TIME = Duration.fromObject({ minutes: 5 }).as(
  "milliseconds",
);

export interface PermissionSetsQueryOptions {
  enabled?: boolean;
  pageSize?: number;
  refetchOnMount?: boolean | "always";
  refetchOnReconnect?: boolean | "always";
  refetchOnWindowFocus?: boolean | "always";
}

export function usePermissionSets(
  query = "",
  options: PermissionSetsQueryOptions = {},
) {
  const queryClient = useQueryClient();
  const { pageSize = PERMISSION_SETS_PAGE_SIZE, ...queryOptions } = options;
  const normalizedQuery = query
    .trim()
    .slice(0, PERMISSION_SETS_QUERY_MAX_LENGTH);
  const queryKey = [
    PERMISSION_SETS_QUERY_KEY,
    normalizedQuery,
    pageSize,
  ] as const;
  const listQuery = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) =>
      getPermissionSetService().listPermissionSets(
        {
          maxResults: pageSize,
          pageIdentifier: pageParam,
          q: normalizedQuery || undefined,
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextPageIdentifier,
    staleTime: PERMISSION_SETS_STALE_TIME,
    ...queryOptions,
  });

  return {
    ...listQuery,
    permissionSets: listQuery.data?.pages.flatMap((page) => page.result) ?? [],
    reloadCatalog: () => queryClient.resetQueries({ queryKey, exact: true }),
  };
}
