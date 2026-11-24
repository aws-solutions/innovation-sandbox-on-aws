// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { isAssignmentLockActive } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { LeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { getLeaseService } from "@amzn/innovation-sandbox-frontend/domains/leases/service";
import { SharedLeaseQueryAccessType } from "@amzn/innovation-sandbox-frontend/domains/leases/smithy-client";
import {
  AssignmentPrincipalRef,
  CostHistoryPageOptions,
  CostHistoryRange,
  LeasePatchRequest,
  NewLeaseRequest,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import { getUserEmail } from "@amzn/innovation-sandbox-shared/utils/auth-utils";

const fetchLeases = async () => await getLeaseService().getLeases();

const LOCK_POLL_INTERVAL_MS = 5_000;

/**
 * How often to refetch the lease list. The 1-minute staleTime would otherwise
 * leave the bulk action menu deciding on stale lock state. Keyed on lock
 * liveness rather than presence, so an expired lock stops polling.
 */
export const leaseListPollInterval = (
  leases?: Pick<LeaseView, "resourceLock">[],
): number | false =>
  leases?.some(isAssignmentLockActive) ? LOCK_POLL_INTERVAL_MS : false;

export const useGetLeases = (options?: { enabled?: boolean }) => {
  return useQuery({
    queryKey: ["leases"],
    queryFn: fetchLeases,
    staleTime: 60 * 1000, // 1 minute
    // Refetch on mount so SPA navigation reflects cross-session changes.
    refetchOnMount: "always",
    enabled: options?.enabled ?? true,
    refetchInterval: (query) => leaseListPollInterval(query.state.data),
  });
};

export const useGetPendingApprovals = () => {
  return useQuery({
    queryKey: ["leases"], // Same query key as useGetLeases
    queryFn: fetchLeases,
    staleTime: 60 * 1000, // 1 minute
    refetchOnMount: "always",
    select: (data) => {
      // Filter for pending approvals
      return data?.filter((lease) => lease.status === "PendingApproval") ?? [];
    },
  });
};

export const useGetLeasesByEmail = (email: string) => {
  return useQuery({
    queryKey: ["leases", email],
    queryFn: async () => await getLeaseService().getLeases(email),
    refetchOnMount: "always",
  });
};

export const useGetLeaseById = (
  uuid?: string,
  { pollWhileLocked = false } = {},
) => {
  return useQuery({
    queryKey: ["leases", uuid],
    queryFn: async () => await getLeaseService().getLeaseById(uuid!),
    enabled: !!uuid,
    refetchOnMount: "always",
    refetchInterval: (query) => {
      if (!pollWhileLocked) return false;
      const lease = query.state.data;
      return lease && isAssignmentLockActive(lease) ? 5_000 : false;
    },
  });
};

/**
 * Reads the lease that `useGetLeaseById` holds again, for a view that sets the
 * lease's own figures beside ones it has just read again, so that neither is
 * older than the other. The lease's query keeps its own options, polling
 * included.
 */
export const useRefetchLeaseById = (uuid: string | undefined) => {
  const client = useQueryClient();
  return () =>
    client.refetchQueries({ queryKey: ["leases", uuid], exact: true });
};

export const useLeasesForCurrentUser = () => {
  const { user } = useUser();
  const userEmail = user ? getUserEmail(user) : undefined;

  return useQuery({
    queryKey: ["leases", userEmail],
    queryFn: async () => {
      if (!userEmail) {
        return [];
      }
      return await getLeaseService().getLeases(userEmail);
    },
    enabled: !!userEmail, // Only run query when user email is available
    staleTime: 60 * 1000, // 1 minute
    refetchOnMount: "always",
  });
};

export const useRequestNewLease = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (request: NewLeaseRequest) =>
      await getLeaseService().requestNewLease(request),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
      client.invalidateQueries({ queryKey: ["accounts"], refetchType: "all" });
    },
  });
};

export const useUpdateLease = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (request: LeasePatchRequest) =>
      await getLeaseService().updateLease(request),
    onSuccess: (_data, request) => {
      client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
      // The cost summary figures budget exhaustion against maxSpend.
      client.invalidateQueries({
        queryKey: ["leaseCostHistory", request.leaseId, "costSummary"],
        refetchType: "all",
      });
    },
  });
};

export const useReviewLease = (options?: { skipInvalidation?: boolean }) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      leaseId,
      approve,
    }: {
      leaseId: string;
      approve: boolean;
    }) => {
      await getLeaseService().reviewLease(leaseId, approve);
    },
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["sharedLeases"],
          refetchType: "all",
        });
      }
    },
  });
};

export const useTerminateLease = (options?: { skipInvalidation?: boolean }) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseId: string) => {
      await getLeaseService().terminateLease(leaseId);
    },
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["sharedLeases"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["assignments"],
          refetchType: "all",
        });
      }
    },
  });
};

export const useFreezeLease = (options?: { skipInvalidation?: boolean }) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseId: string) => {
      await getLeaseService().freezeLease(leaseId);
    },
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["sharedLeases"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["assignments"],
          refetchType: "all",
        });
      }
    },
  });
};

export const useGetAssignments = (leaseId?: string) => {
  return useQuery({
    queryKey: ["assignments", leaseId],
    queryFn: async () => await getLeaseService().getAssignments(leaseId!),
    enabled: !!leaseId,
    refetchOnMount: "always",
  });
};

type UseUpdateAssignmentsOptions = {
  refetchAssignmentsOnSuccess?: boolean;
};

export const useUpdateAssignments = ({
  refetchAssignmentsOnSuccess = true,
}: UseUpdateAssignmentsOptions = {}) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      leaseId,
      assignments,
    }: {
      leaseId: string;
      assignments: AssignmentPrincipalRef[];
    }) => await getLeaseService().updateAssignments(leaseId, assignments),
    onSuccess: async (_result, { leaseId }) => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: ["assignments", leaseId],
          refetchType: refetchAssignmentsOnSuccess ? "all" : "none",
        }),
        client.invalidateQueries({
          queryKey: ["leases"],
          refetchType: "all",
        }),
        client.invalidateQueries({
          queryKey: ["sharedLeases"],
          refetchType: "all",
        }),
      ]);
    },
  });
};

/**
 * Fetches all shared leases for the current user by access type.
 *
 * The service layer exhaustively fetches all pages (maxResults=100) so the
 * frontend has the complete dataset for client-side filtering and pagination.
 */
export const useGetSharedLeases = (accessType: SharedLeaseQueryAccessType) => {
  const { user } = useUser();
  const userId = user?.userId;

  return useQuery({
    queryKey: ["sharedLeases", accessType, userId],
    queryFn: async () => {
      return await getLeaseService().getSharedLeases(userId!, accessType);
    },
    enabled: !!userId,
    staleTime: 60 * 1000, // 1 minute
    refetchOnMount: "always",
    placeholderData: keepPreviousData,
  });
};

export const useUnfreezeLease = (options?: { skipInvalidation?: boolean }) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseId: string) => {
      await getLeaseService().unfreezeLease(leaseId);
    },
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["sharedLeases"],
          refetchType: "all",
        });
        client.invalidateQueries({
          queryKey: ["assignments"],
          refetchType: "all",
        });
      }
    },
  });
};

export const useGetLeaseCostSummary = (leaseId: string | undefined) => {
  return useQuery({
    queryKey: ["leaseCostHistory", leaseId, "costSummary"],
    queryFn: async () => await getLeaseService().getLeaseCostSummary(leaseId!),
    enabled: !!leaseId,
    refetchOnMount: "always",
  });
};

export const useGetLeaseBedrockTokenHistory = (
  leaseId: string | undefined,
  page: CostHistoryPageOptions,
) => {
  return useQuery({
    queryKey: [
      "leaseCostHistory",
      leaseId,
      "bedrockTokenHistoryPage",
      page.maxResults,
      page.pageIdentifier,
      page.afterTimestamp,
      page.beforeTimestamp,
    ],
    queryFn: async () =>
      await getLeaseService().getLeaseBedrockTokenHistory(leaseId!, page),
    enabled: !!leaseId,
    refetchOnMount: "always",
  });
};

/**
 * The newest Bedrock token reading before a range's start, which the range's
 * first change is measured from: one page of one reading, ending at the start,
 * which the exclusive upper bound leaves out. Not read without a start; keyed by
 * it, so a new range reads its own.
 */
export const useGetLeaseBedrockTokenBaseline = (
  leaseId: string | undefined,
  rangeStart: string | undefined,
) => {
  return useQuery({
    queryKey: ["leaseCostHistory", leaseId, "bedrockTokenBaseline", rangeStart],
    queryFn: async () =>
      await getLeaseService().getLeaseBedrockTokenHistory(leaseId!, {
        beforeTimestamp: rangeStart!,
        maxResults: 1,
      }),
    enabled: !!leaseId && rangeStart !== undefined,
    refetchOnMount: "always",
  });
};

export const useGetMergedLeaseCostHistory = (
  leaseId: string | undefined,
  range?: CostHistoryRange,
) => {
  return useQuery({
    queryKey: [
      "leaseCostHistory",
      leaseId,
      "costHistory",
      range?.afterTimestamp,
      range?.beforeTimestamp,
    ],
    queryFn: async () =>
      await getLeaseService().getMergedLeaseCostHistory(leaseId!, range),
    enabled: !!leaseId,
    refetchOnMount: "always",
  });
};

export const useGetMergedLeaseBedrockTokenHistory = (
  leaseId: string | undefined,
  range?: CostHistoryRange,
) => {
  return useQuery({
    queryKey: [
      "leaseCostHistory",
      leaseId,
      "bedrockTokenHistory",
      range?.afterTimestamp,
      range?.beforeTimestamp,
    ],
    queryFn: async () =>
      await getLeaseService().getMergedLeaseBedrockTokenHistory(
        leaseId!,
        range,
      ),
    enabled: !!leaseId,
    refetchOnMount: "always",
  });
};

export const useGetMergedLeaseBreachHistory = (
  leaseId: string | undefined,
  range?: CostHistoryRange,
) => {
  return useQuery({
    queryKey: [
      "leaseCostHistory",
      leaseId,
      "breachHistory",
      range?.afterTimestamp,
      range?.beforeTimestamp,
    ],
    queryFn: async () =>
      await getLeaseService().getMergedLeaseBreachHistory(leaseId!, range),
    enabled: !!leaseId,
    refetchOnMount: "always",
  });
};
