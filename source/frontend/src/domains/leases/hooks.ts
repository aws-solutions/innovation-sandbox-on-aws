// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { LeaseService } from "@amzn/innovation-sandbox-frontend/domains/leases/service";
import {
  LeasePatchRequest,
  NewLeaseRequest,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

const fetchLeases = async () => await new LeaseService().getLeases();

export const useGetLeases = () => {
  return useQuery({
    queryKey: ["leases"],
    queryFn: fetchLeases,
  });
};

export const useGetPendingApprovals = () => {
  return useQuery({
    queryKey: ["leases"], // Same query key as useGetLeases
    queryFn: fetchLeases,
    select: (data) => {
      // Filter for pending approvals
      return data?.filter((lease) => lease.status === "PendingApproval") ?? [];
    },
  });
};

export const useGetLeasesByEmail = (email: string) => {
  return useQuery({
    queryKey: ["leases", email],
    queryFn: async () => await new LeaseService().getLeases(email),
  });
};

export const useGetLeaseById = (uuid: string) => {
  return useQuery({
    queryKey: ["leases", uuid],
    queryFn: async () => await new LeaseService().getLeaseById(uuid),
  });
};

export const useLeasesForCurrentUser = () => {
  const { user } = useUser();

  return useQuery({
    queryKey: ["leases", user?.email],
    queryFn: async () => {
      if (!user?.email) {
        return [];
      }
      return await new LeaseService().getLeases(user.email);
    },
    enabled: !!user?.email, // Only run query when user email is available
  });
};

export const useRequestNewLease = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (request: NewLeaseRequest) =>
      await new LeaseService().requestNewLease(request),
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
      await new LeaseService().updateLease(request),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
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
      await new LeaseService().reviewLease(leaseId, approve);
    },
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
        client.invalidateQueries({
          queryKey: ["accounts"],
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
      await new LeaseService().terminateLease(leaseId);
    },
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
        client.invalidateQueries({
          queryKey: ["accounts"],
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
      await new LeaseService().freezeLease(leaseId);
    },
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
      }
    },
  });
};

export const useUnfreezeLease = (options?: { skipInvalidation?: boolean }) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (leaseId: string) => {
      await new LeaseService().unfreezeLease(leaseId);
    },
    onSuccess: () => {
      // Only invalidate if skipInvalidation is not set
      if (!options?.skipInvalidation) {
        client.invalidateQueries({ queryKey: ["leases"], refetchType: "all" });
        client.invalidateQueries({
          queryKey: ["accounts"],
          refetchType: "all",
        });
      }
    },
  });
};
