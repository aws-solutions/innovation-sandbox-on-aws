// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from "@testing-library/react";
import { DateTime } from "luxon";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toCostHistoryRange } from "@amzn/innovation-sandbox-frontend/domains/leases/components/cost-history-range";
import {
  useFreezeLease,
  useGetAssignments,
  useGetLeaseBedrockTokenBaseline,
  useGetLeaseBedrockTokenHistory,
  useGetLeaseById,
  useGetLeaseCostSummary,
  useGetLeases,
  useGetLeasesByEmail,
  useGetMergedLeaseBedrockTokenHistory,
  useGetMergedLeaseBreachHistory,
  useGetMergedLeaseCostHistory,
  useGetPendingApprovals,
  useGetSharedLeases,
  useLeasesForCurrentUser,
  useRefetchLeaseById,
  useRequestNewLease,
  useReviewLease,
  useTerminateLease,
  useUnfreezeLease,
  useUpdateAssignments,
  useUpdateLease,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import type { LeaseAssignmentView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import type {
  AssignmentPrincipalRef,
  CostHistoryPageOptions,
  LeasePatchRequest,
  NewLeaseRequest,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  leaseBedrockTokenHistoryGetHandler,
  leaseBreachHistoryGetHandler,
  leaseCostHistoryGetHandler,
  leaseCostSummaryGetHandler,
  mockApiLease,
  mockCostHistoryLeaseId,
  mockForbiddenCostHistoryLeaseId,
  mockLease,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";
import {
  createMockBedrockTokenCostHistory,
  createMockCostHistory,
  createMockLeaseEndBreachCostHistory,
  createMockNoCurrentCostHistory,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";

vi.mock(
  "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService",
  async () => {
    const [{ authenticated }, { buildCognitoAuthServiceMock }] =
      await Promise.all([
        import("@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures"),
        import("@amzn/innovation-sandbox-frontend-test/utils/cognitoServiceMock"),
      ]);
    return {
      CognitoAuthService: buildCognitoAuthServiceMock({
        getCurrentUser: vi.fn().mockResolvedValue(authenticated()),
      }),
    };
  },
);

// The read-path assertions below serve `mockApiLease` (not the raw `mockLease`)
// as the response body: it's the shape the real server puts on the wire — the
// restJson1 serializer drops `null`/unset/`schemaVersion` members. Serving the
// raw `mockLease` would leak faker-random `null` members that `HttpResponse.json`
// preserves and the client deserializer keeps, so the round-trip would flake
// (an extra key some runs, not others). Keep these handlers on `mockApiLease`.
describe("Lease hooks", () => {
  describe("useLeasesForCurrentUser", () => {
    it("should fetch leases successfully", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json({
            status: "success",
            data: { result: [mockApiLease], nextPageIdentifier: null },
          });
        }),
      );

      const { result } = renderHook(() => useLeasesForCurrentUser(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual([mockApiLease]);
    });

    it("should handle error when fetching leases fails", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to fetch" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useLeasesForCurrentUser(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeDefined();
    });
  });

  describe("refetchOnMount", () => {
    it("useGetLeases refetches on every mount even within staleTime", async () => {
      // "always" refetches on remount even within staleTime; the default
      // (true) would skip the second mount, which is the stale-data bug.
      let calls = 0;
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          calls++;
          return HttpResponse.json({
            status: "success",
            data: { result: [mockLease], nextPageIdentifier: null },
          });
        }),
      );

      const wrapper = createQueryClientWrapper();
      const first = renderHook(() => useGetLeases(), { wrapper });
      await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
      expect(calls).toBe(1);
      first.unmount();

      const second = renderHook(() => useGetLeases(), { wrapper });
      await waitFor(() => expect(calls).toBe(2));
      expect(second.result.current.isSuccess).toBe(true);
    });
  });

  describe("useRequestNewLease", () => {
    it("should request a new lease successfully", async () => {
      const { result } = renderHook(() => useRequestNewLease(), {
        wrapper: createQueryClientWrapper(),
      });

      const newLeaseRequest: NewLeaseRequest = {
        leaseTemplateUuid: "template-uuid-123",
      };

      let apiCallMade = false;
      server.use(
        http.post(`${getConfig().ApiUrl}/leases`, async ({ request }) => {
          const body = await request.json();
          expect(body).toEqual(newLeaseRequest);
          apiCallMade = true;
          return HttpResponse.json({ status: "success" }, { status: 200 });
        }),
      );

      result.current.mutate(newLeaseRequest);

      await waitFor(
        () => {
          expect(result.current.isSuccess).toBe(true);
        },
        { timeout: 5000 },
      );

      expect(apiCallMade).toBe(true);
      expect(result.current.isError).toBe(false);
      expect(result.current.data).toBeUndefined();
    });

    it("should handle error when requesting a new lease fails", async () => {
      server.use(
        http.post(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to create lease" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useRequestNewLease(), {
        wrapper: createQueryClientWrapper(),
      });

      const newLeaseRequest = {
        leaseTemplateUuid: "template-uuid-123",
      };

      result.current.mutate(newLeaseRequest);

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetAssignments", () => {
    const leaseId = "lease-uuid-1";
    const mockAssignments: LeaseAssignmentView[] = [
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "Alice Smith",
        assigneeEmail: "alice@example.com",
        addedBy: "owner@example.com",
        addedDate: "2026-01-01T00:00:00.000Z",
        isOwner: false,
        isDesired: true,
        syncStatus: "active",
        permissionSet: {
          permissionSetArn:
            "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
          permissionSetId: "ps-0123456789abcdef",
          name: "BuiltInUserAccess",
          availability: "AVAILABLE",
        },
      },
      {
        principalId: "group-1",
        principalType: "GROUP",
        displayName: "Engineering",
        addedBy: "owner@example.com",
        addedDate: "2026-01-02T00:00:00.000Z",
        isOwner: false,
        isDesired: true,
        syncStatus: "active",
        permissionSet: {
          permissionSetArn:
            "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
          permissionSetId: "ps-0123456789abcdef",
          name: "BuiltInUserAccess",
          availability: "AVAILABLE",
        },
      },
    ];

    it("should fetch assignments for the given leaseId", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/${leaseId}/assignments`, () =>
          HttpResponse.json({
            status: "success",
            data: { assignments: mockAssignments },
          }),
        ),
      );

      const { result } = renderHook(() => useGetAssignments(leaseId), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.assignments).toEqual(mockAssignments);
    });

    it("does not retain assignments from the previous lease", async () => {
      const nextLeaseId = "lease-uuid-2";
      const nextAssignments = [
        {
          ...mockAssignments[0],
          principalId: "user-2",
          displayName: "Bob",
          assigneeEmail: "bob@example.com",
        },
      ];
      let releaseNextResponse!: () => void;
      const nextResponseReady = new Promise<void>((resolve) => {
        releaseNextResponse = resolve;
      });
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/${leaseId}/assignments`, () =>
          HttpResponse.json({
            status: "success",
            data: { assignments: mockAssignments },
          }),
        ),
        http.get(
          `${getConfig().ApiUrl}/leases/${nextLeaseId}/assignments`,
          async () => {
            await nextResponseReady;
            return HttpResponse.json({
              status: "success",
              data: { assignments: nextAssignments },
            });
          },
        ),
      );

      const { result, rerender } = renderHook(
        ({ currentLeaseId }) => useGetAssignments(currentLeaseId),
        {
          initialProps: { currentLeaseId: leaseId },
          wrapper: createQueryClientWrapper(),
        },
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      rerender({ currentLeaseId: nextLeaseId });

      await waitFor(() => expect(result.current.isFetching).toBe(true));
      expect(result.current.data).toBeUndefined();

      releaseNextResponse();
      await waitFor(() =>
        expect(result.current.data?.assignments).toEqual(nextAssignments),
      );
    });

    it("should handle errors from the assignments endpoint", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/${leaseId}/assignments`, () =>
          HttpResponse.json(
            { status: "error", message: "boom" },
            { status: 500 },
          ),
        ),
      );

      const { result } = renderHook(() => useGetAssignments(leaseId), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useUpdateAssignments", () => {
    const leaseId = "lease-uuid-1";
    const desired: AssignmentPrincipalRef[] = [
      { principalId: "user-1", principalType: "USER" },
      { principalId: "group-1", principalType: "GROUP" },
    ];

    it("PUTs the desired assignments and returns desiredCount", async () => {
      let receivedBody: unknown;
      server.use(
        http.put(
          `${getConfig().ApiUrl}/leases/${leaseId}/assignments`,
          async ({ request }) => {
            receivedBody = await request.json();
            return HttpResponse.json(
              { status: "success", data: { desiredCount: desired.length } },
              { status: 202 },
            );
          },
        ),
      );

      const { result } = renderHook(() => useUpdateAssignments(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ leaseId, assignments: desired });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(receivedBody).toEqual({ assignments: desired });
      expect(result.current.data).toEqual({ desiredCount: desired.length });
    });

    it("refetches the matching assignments query after an update", async () => {
      let getCalls = 0;
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/${leaseId}/assignments`, () => {
          getCalls++;
          return HttpResponse.json({
            status: "success",
            data: { assignments: [] },
          });
        }),
        http.put(`${getConfig().ApiUrl}/leases/${leaseId}/assignments`, () =>
          HttpResponse.json(
            { status: "success", data: { desiredCount: desired.length } },
            { status: 202 },
          ),
        ),
      );

      const { result } = renderHook(
        () => ({
          assignments: useGetAssignments(leaseId),
          update: useUpdateAssignments(),
        }),
        { wrapper: createQueryClientWrapper() },
      );

      await waitFor(() =>
        expect(result.current.assignments.isSuccess).toBe(true),
      );
      expect(getCalls).toBe(1);

      result.current.update.mutate({ leaseId, assignments: desired });

      await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
      expect(getCalls).toBe(2);
    });

    it("surfaces errors from the assignments endpoint", async () => {
      server.use(
        http.put(`${getConfig().ApiUrl}/leases/${leaseId}/assignments`, () =>
          HttpResponse.json(
            { status: "error", message: "lock held" },
            { status: 409 },
          ),
        ),
      );

      const { result } = renderHook(() => useUpdateAssignments(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ leaseId, assignments: desired });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetSharedLeases", () => {
    const mockDirectLease = {
      ...mockLease,
      leaseId: "encoded-lease-id-1",
      accessType: "direct" as const,
    };

    const mockGroupLease = {
      ...mockLease,
      leaseId: "encoded-lease-id-2",
      accessType: "group" as const,
      sourceGroupName: "Engineering",
    };

    it("should fetch direct shared leases for the current user", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/shared`, ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("accessType")).toBe("direct");
          expect(url.searchParams.get("userId")).toBeDefined();
          return HttpResponse.json({
            status: "success",
            data: { result: [mockDirectLease], nextPageIdentifier: null },
          });
        }),
      );

      const { result } = renderHook(() => useGetSharedLeases("direct"), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.result).toHaveLength(1);
      expect(result.current.data?.result[0].accessType).toBe("direct");
    });

    it("should fetch group shared leases for the current user", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/shared`, ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("accessType")).toBe("group");
          return HttpResponse.json({
            status: "success",
            data: { result: [mockGroupLease], nextPageIdentifier: null },
          });
        }),
      );

      const { result } = renderHook(() => useGetSharedLeases("group"), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.result).toHaveLength(1);
      expect(result.current.data?.result[0].accessType).toBe("group");
      expect(result.current.data?.result[0].sourceGroupName).toBe(
        "Engineering",
      );
    });

    it("should exhaustively paginate until nextPageIdentifier is null", async () => {
      let callCount = 0;
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/shared`, ({ request }) => {
          callCount++;
          const url = new URL(request.url);
          if (!url.searchParams.has("pageIdentifier")) {
            // First page
            return HttpResponse.json({
              status: "success",
              data: {
                result: [mockDirectLease],
                nextPageIdentifier: "cursor-page-2",
              },
            });
          }
          // Second page (final)
          return HttpResponse.json({
            status: "success",
            data: {
              result: [{ ...mockDirectLease, leaseId: "encoded-lease-id-3" }],
              nextPageIdentifier: null,
            },
          });
        }),
      );

      const { result } = renderHook(() => useGetSharedLeases("direct"), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(callCount).toBe(2);
      expect(result.current.data?.result).toHaveLength(2);
      expect(result.current.data?.nextPageIdentifier).toBeNull();
    });

    it("should handle errors from the shared leases endpoint", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/shared`, () =>
          HttpResponse.json(
            { status: "fail", data: { errors: [{ message: "Unauthorized" }] } },
            { status: 403 },
          ),
        ),
      );

      const { result } = renderHook(() => useGetSharedLeases("direct"), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetLeases", () => {
    it("should fetch all leases successfully", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json({
            status: "success",
            data: { result: [mockApiLease], nextPageIdentifier: null },
          });
        }),
      );

      const { result } = renderHook(() => useGetLeases(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([mockApiLease]);
    });

    it("should handle error when fetching leases fails", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to fetch" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useGetLeases(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetPendingApprovals", () => {
    it("should select only leases with PendingApproval status", async () => {
      const pendingLease = {
        ...mockLease,
        leaseId: "pending-1",
        status: "PendingApproval",
      };
      const activeLease = {
        ...mockLease,
        leaseId: "active-1",
        status: "Active",
      };

      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json({
            status: "success",
            data: {
              result: [pendingLease, activeLease],
              nextPageIdentifier: null,
            },
          });
        }),
      );

      const { result } = renderHook(() => useGetPendingApprovals(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data![0].status).toBe("PendingApproval");
    });

    it("should return empty array when no pending approvals exist", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json({
            status: "success",
            data: {
              result: [{ ...mockLease, status: "Active" }],
              nextPageIdentifier: null,
            },
          });
        }),
      );

      const { result } = renderHook(() => useGetPendingApprovals(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toHaveLength(0);
    });
  });

  describe("useGetLeasesByEmail", () => {
    it("should fetch leases filtered by email", async () => {
      const email = "user@example.com";
      let receivedUrl: URL | undefined;

      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, ({ request }) => {
          receivedUrl = new URL(request.url);
          return HttpResponse.json({
            status: "success",
            data: { result: [mockApiLease], nextPageIdentifier: null },
          });
        }),
      );

      const { result } = renderHook(() => useGetLeasesByEmail(email), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual([mockApiLease]);
      expect(receivedUrl?.searchParams.get("userEmail")).toBe(email);
    });

    it("should handle error when fetching leases by email fails", async () => {
      server.use(
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to fetch" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(
        () => useGetLeasesByEmail("user@example.com"),
        { wrapper: createQueryClientWrapper() },
      );

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetLeaseById", () => {
    it("should fetch a single lease by id", async () => {
      const leaseId = "lease-uuid-123";

      server.use(
        http.get(`${getConfig().ApiUrl}/leases/${leaseId}`, () => {
          return HttpResponse.json({
            status: "success",
            data: mockApiLease,
          });
        }),
      );

      const { result } = renderHook(() => useGetLeaseById(leaseId), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(mockApiLease);
    });

    it("should not fetch when uuid is undefined", async () => {
      let apiCalled = false;
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/:id`, () => {
          apiCalled = true;
          return HttpResponse.json({
            status: "success",
            data: mockLease,
          });
        }),
      );

      const { result } = renderHook(() => useGetLeaseById(undefined), {
        wrapper: createQueryClientWrapper(),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(apiCalled).toBe(false);
      expect(result.current.fetchStatus).toBe("idle");
      expect(result.current.data).toBeUndefined();
    });

    it("should handle error when fetching lease by id fails", async () => {
      const leaseId = "lease-uuid-123";

      server.use(
        http.get(`${getConfig().ApiUrl}/leases/${leaseId}`, () => {
          return HttpResponse.json(
            { status: "error", message: "Not found" },
            { status: 404 },
          );
        }),
      );

      const { result } = renderHook(() => useGetLeaseById(leaseId), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useRefetchLeaseById", () => {
    it("reads the lease again, and no other lease query", async () => {
      const leaseId = "lease-uuid-123";
      let leaseReads = 0;
      let listReads = 0;
      server.use(
        http.get(`${getConfig().ApiUrl}/leases/${leaseId}`, () => {
          leaseReads++;
          return HttpResponse.json({ status: "success", data: mockApiLease });
        }),
        http.get(`${getConfig().ApiUrl}/leases`, () => {
          listReads++;
          return HttpResponse.json({
            status: "success",
            data: { result: [mockApiLease], nextPageIdentifier: null },
          });
        }),
      );

      const { result } = renderHook(
        () => ({
          lease: useGetLeaseById(leaseId),
          leases: useGetLeases(),
          refetchLease: useRefetchLeaseById(leaseId),
        }),
        { wrapper: createQueryClientWrapper() },
      );
      await waitFor(() => expect(result.current.lease.isSuccess).toBe(true));
      await waitFor(() => expect(result.current.leases.isSuccess).toBe(true));

      await result.current.refetchLease();

      expect(leaseReads).toBe(2);
      expect(listReads).toBe(1);
    });
  });

  describe("useUpdateLease", () => {
    it("should PATCH a lease successfully", async () => {
      const patchRequest: LeasePatchRequest = {
        leaseId: "lease-uuid-123",
        maxSpend: 500,
      };

      let receivedBody: unknown;
      server.use(
        http.patch(
          `${getConfig().ApiUrl}/leases/${patchRequest.leaseId}`,
          async ({ request }) => {
            receivedBody = await request.json();
            return HttpResponse.json({ status: "success" }, { status: 200 });
          },
        ),
      );

      const { result } = renderHook(() => useUpdateLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate(patchRequest);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(receivedBody).toEqual({ maxSpend: 500 });
    });

    it("should handle error when updating lease fails", async () => {
      server.use(
        http.patch(`${getConfig().ApiUrl}/leases/:id`, () => {
          return HttpResponse.json(
            { status: "error", message: "Update failed" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useUpdateLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ leaseId: "lease-uuid-123", maxSpend: 500 });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useReviewLease", () => {
    it("should POST to review endpoint with approve action", async () => {
      const leaseId = "lease-uuid-123";
      let receivedBody: unknown;

      server.use(
        http.post(
          `${getConfig().ApiUrl}/leases/${leaseId}/review`,
          async ({ request }) => {
            receivedBody = await request.json();
            return HttpResponse.json({ status: "success" }, { status: 200 });
          },
        ),
      );

      const { result } = renderHook(() => useReviewLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ leaseId, approve: true });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(receivedBody).toEqual({ action: "Approve" });
    });

    it("should POST to review endpoint with deny action", async () => {
      const leaseId = "lease-uuid-123";
      let receivedBody: unknown;

      server.use(
        http.post(
          `${getConfig().ApiUrl}/leases/${leaseId}/review`,
          async ({ request }) => {
            receivedBody = await request.json();
            return HttpResponse.json({ status: "success" }, { status: 200 });
          },
        ),
      );

      const { result } = renderHook(() => useReviewLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ leaseId, approve: false });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(receivedBody).toEqual({ action: "Deny" });
    });

    it("should handle error when review fails", async () => {
      server.use(
        http.post(`${getConfig().ApiUrl}/leases/:id/review`, () => {
          return HttpResponse.json(
            { status: "error", message: "Review failed" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useReviewLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ leaseId: "lease-uuid-123", approve: true });

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useTerminateLease", () => {
    it("should POST to terminate endpoint successfully", async () => {
      const leaseId = "lease-uuid-123";
      let apiCallMade = false;

      server.use(
        http.post(`${getConfig().ApiUrl}/leases/${leaseId}/terminate`, () => {
          apiCallMade = true;
          return HttpResponse.json({ status: "success" }, { status: 200 });
        }),
      );

      const { result } = renderHook(() => useTerminateLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate(leaseId);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(apiCallMade).toBe(true);
    });

    it("should handle error when termination fails", async () => {
      server.use(
        http.post(`${getConfig().ApiUrl}/leases/:id/terminate`, () => {
          return HttpResponse.json(
            { status: "error", message: "Termination failed" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useTerminateLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate("lease-uuid-123");

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useFreezeLease", () => {
    it("should POST to freeze endpoint successfully", async () => {
      const leaseId = "lease-uuid-123";
      let apiCallMade = false;

      server.use(
        http.post(`${getConfig().ApiUrl}/leases/${leaseId}/freeze`, () => {
          apiCallMade = true;
          return HttpResponse.json({ status: "success" }, { status: 200 });
        }),
      );

      const { result } = renderHook(() => useFreezeLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate(leaseId);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(apiCallMade).toBe(true);
    });

    it("should handle error when freeze fails", async () => {
      server.use(
        http.post(`${getConfig().ApiUrl}/leases/:id/freeze`, () => {
          return HttpResponse.json(
            { status: "error", message: "Freeze failed" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useFreezeLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate("lease-uuid-123");

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  describe("useUnfreezeLease", () => {
    it("should POST to unfreeze endpoint successfully", async () => {
      const leaseId = "lease-uuid-123";
      let apiCallMade = false;

      server.use(
        http.post(`${getConfig().ApiUrl}/leases/${leaseId}/unfreeze`, () => {
          apiCallMade = true;
          return HttpResponse.json({ status: "success" }, { status: 200 });
        }),
      );

      const { result } = renderHook(() => useUnfreezeLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate(leaseId);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(apiCallMade).toBe(true);
    });

    it("should handle error when unfreeze fails", async () => {
      server.use(
        http.post(`${getConfig().ApiUrl}/leases/:id/unfreeze`, () => {
          return HttpResponse.json(
            { status: "error", message: "Unfreeze failed" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useUnfreezeLease(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate("lease-uuid-123");

      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.error).toBeDefined();
    });
  });

  type CostRoute =
    "costSummary" | "costHistory" | "bedrockTokenHistory" | "breachHistory";

  // Falls through to the handler serving the fixture, having noted the query.
  const recordQueries = (route: CostRoute) => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get(
        `${getConfig().ApiUrl}/leases/:leaseId/${route}`,
        ({ request }) => {
          queries.push(new URL(request.url).searchParams);
        },
      ),
    );
    return queries;
  };

  // `count` copies of the fixture's first row, a minute apart, newest first.
  const series = <T extends { timestamp: string }>(row: T, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      ...row,
      timestamp: DateTime.fromISO("2026-08-11T12:00:00.000Z")
        .minus({ minutes: index })
        .toUTC()
        .toISO()!,
    }));

  // The fixture's token rows at the given readings.
  const tokenRowsAt = (...timestamps: string[]) =>
    createMockBedrockTokenCostHistory().data.tokens.filter(({ timestamp }) =>
      timestamps.includes(timestamp),
    );

  describe("useGetLeaseCostSummary", () => {
    const renderSummary = (leaseId: string | undefined) =>
      renderHook(() => useGetLeaseCostSummary(leaseId), {
        wrapper: createQueryClientWrapper(),
      });

    it("should resolve the fixture's newest figures, asking with no query", async () => {
      const queries = recordQueries("costSummary");

      const { result } = renderSummary(mockCostHistoryLeaseId);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual({
        current: createMockCostHistory().data.current,
      });
      expect([...queries[0]!.keys()]).toEqual([]);
    });

    it("should resolve with no figures where no reading is available", async () => {
      server.use(leaseCostSummaryGetHandler(createMockNoCurrentCostHistory()));

      const { result } = renderSummary(mockCostHistoryLeaseId);

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data!.current).toBeUndefined();
    });

    it("should error for an unknown lease", async () => {
      const { result } = renderSummary("dW5rbm93bi1sZWFzZQ");

      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    it("should error for a lease the caller cannot read", async () => {
      const { result } = renderSummary(mockForbiddenCostHistoryLeaseId);

      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    it("should not fetch without a leaseId", () => {
      const { result } = renderSummary(undefined);

      expect(result.current.fetchStatus).toBe("idle");
    });
  });

  describe("useGetLeaseBedrockTokenHistory", () => {
    const renderTokenPage = (
      leaseId: string | undefined,
      page: CostHistoryPageOptions,
    ) =>
      renderHook(() => useGetLeaseBedrockTokenHistory(leaseId, page), {
        wrapper: createQueryClientWrapper(),
      });

    const NEWEST = "2026-08-11T11:00:00.000Z";

    it("should resolve the newest reading, a row per region and model, for one result", async () => {
      server.use(
        leaseBedrockTokenHistoryGetHandler(createMockBedrockTokenCostHistory()),
      );

      const { result } = renderTokenPage(mockCostHistoryLeaseId, {
        maxResults: 1,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data!.result).toEqual(tokenRowsAt(NEWEST));
      expect(result.current.data!.nextPageIdentifier).toBe("1");
    });

    it("should error for an unknown lease", async () => {
      const { result } = renderTokenPage("dW5rbm93bi1sZWFzZQ", {});

      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    it("should error for a lease the caller cannot read", async () => {
      const { result } = renderTokenPage(mockForbiddenCostHistoryLeaseId, {});

      await waitFor(() => expect(result.current.isError).toBe(true));
    });

    it("should not fetch without a leaseId", () => {
      const { result } = renderTokenPage(undefined, {});

      expect(result.current.fetchStatus).toBe("idle");
    });

    it("should name the pagination parameters maxResults and pageIdentifier on the wire", async () => {
      const queries = recordQueries("bedrockTokenHistory");

      const { result } = renderTokenPage(mockCostHistoryLeaseId, {
        maxResults: 2,
        pageIdentifier: "2",
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const [query] = queries;
      expect(query!.get("maxResults")).toBe("2");
      expect(query!.get("pageIdentifier")).toBe("2");
      expect(query!.has("type")).toBe(false);
    });

    it("should page by reading and return a cursor when truncated", async () => {
      server.use(
        leaseBedrockTokenHistoryGetHandler(createMockBedrockTokenCostHistory()),
      );

      const { result } = renderTokenPage(mockCostHistoryLeaseId, {
        maxResults: 2,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data!.result).toEqual(
        tokenRowsAt(NEWEST, "2026-08-11T10:00:00.000Z"),
      );
      expect(result.current.data!.nextPageIdentifier).toBe("2");
    });

    it("should follow the cursor to the final page", async () => {
      server.use(
        leaseBedrockTokenHistoryGetHandler(createMockBedrockTokenCostHistory()),
      );

      const { result } = renderTokenPage(mockCostHistoryLeaseId, {
        maxResults: 2,
        pageIdentifier: "4",
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data!.result).toEqual(
        tokenRowsAt("2026-08-11T07:00:00.000Z"),
      );
      expect(result.current.data!.nextPageIdentifier).toBeUndefined();
    });

    const clampCases: [string, number, string][] = [
      ["above the maximum", 5000, "100"],
      ["below the minimum", 0, "1"],
    ];

    it.each(clampCases)(
      "should clamp a maxResults %s on the wire",
      async (_case, maxResults, expected) => {
        const queries = recordQueries("bedrockTokenHistory");

        const { result } = renderTokenPage(mockCostHistoryLeaseId, {
          maxResults,
        });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));

        expect(queries[0]!.get("maxResults")).toBe(expected);
      },
    );

    it("should not 400 on a maxResults the endpoint would reject", async () => {
      const { result } = renderTokenPage(mockCostHistoryLeaseId, {
        maxResults: 5000,
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
    });
  });

  describe("useGetLeaseBedrockTokenBaseline", () => {
    const renderBaseline = (rangeStart: string | undefined) =>
      renderHook(
        () =>
          useGetLeaseBedrockTokenBaseline(mockCostHistoryLeaseId, rangeStart),
        { wrapper: createQueryClientWrapper() },
      );

    beforeEach(() => {
      server.use(
        leaseBedrockTokenHistoryGetHandler(createMockBedrockTokenCostHistory()),
      );
    });

    it("should ask for one reading, ending at the range's start", async () => {
      const queries = recordQueries("bedrockTokenHistory");

      const { result } = renderBaseline("2026-08-11T11:00:00.000Z");

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(Object.fromEntries(queries[0]!)).toEqual({
        beforeTimestamp: "2026-08-11T11:00:00.000Z",
        maxResults: "1",
      });
    });

    it("should resolve the newest reading before the range, leaving out the one at its start", async () => {
      const { result } = renderBaseline("2026-08-11T11:00:00.000Z");

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data!.result).toEqual(
        tokenRowsAt("2026-08-11T10:00:00.000Z"),
      );
    });

    it("should resolve no reading and no cursor where none came before the range", async () => {
      const { result } = renderBaseline("2026-08-11T06:00:00.000Z");

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data!.result).toEqual([]);
      expect(result.current.data!.nextPageIdentifier).toBeUndefined();
    });

    it("should read a new range's own reading rather than the last range's", async () => {
      const queries = recordQueries("bedrockTokenHistory");
      const { result, rerender } = renderHook(
        ({ rangeStart }: { rangeStart: string }) =>
          useGetLeaseBedrockTokenBaseline(mockCostHistoryLeaseId, rangeStart),
        {
          wrapper: createQueryClientWrapper(),
          initialProps: { rangeStart: "2026-08-11T11:00:00.000Z" },
        },
      );
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      rerender({ rangeStart: "2026-08-11T09:00:00.000Z" });

      await waitFor(() =>
        expect(result.current.data!.result).toEqual(
          tokenRowsAt("2026-08-11T08:00:00.000Z"),
        ),
      );
      expect(queries.map((query) => query.get("beforeTimestamp"))).toEqual([
        "2026-08-11T11:00:00.000Z",
        "2026-08-11T09:00:00.000Z",
      ]);
    });

    it("should not fetch for a range without a start", () => {
      const { result } = renderBaseline(undefined);

      expect(result.current.fetchStatus).toBe("idle");
    });
  });

  describe("the merged drains", () => {
    it("should drain every cost page, returning the readings alone", async () => {
      const { data } = createMockCostHistory();
      const result = series(data.result[0]!, 150);
      server.use(
        leaseCostHistoryGetHandler({
          status: "success",
          data: { ...data, result },
        }),
      );
      const queries = recordQueries("costHistory");

      const { result: query } = renderHook(
        () => useGetMergedLeaseCostHistory(mockCostHistoryLeaseId),
        { wrapper: createQueryClientWrapper() },
      );

      await waitFor(() => expect(query.current.isSuccess).toBe(true));

      expect(queries).toHaveLength(2);
      expect(query.current.data).toEqual({ result, nextPageIdentifier: null });
    });

    it("should read an absolute range through its end, and not the millisecond after", async () => {
      const { data } = createMockCostHistory();
      const at = (timestamp: string) => ({ ...data.result[0]!, timestamp });
      const result = [
        at("2026-08-11T10:30:00.001Z"),
        at("2026-08-11T10:30:00.000Z"),
        at("2026-08-11T09:00:00.000Z"),
        at("2026-08-11T08:59:59.999Z"),
      ];
      server.use(
        leaseCostHistoryGetHandler({
          status: "success",
          data: { ...data, result },
        }),
      );
      const queries = recordQueries("costHistory");
      // Picked with an offset, so the range is the same instants in any zone.
      const range = toCostHistoryRange({
        type: "absolute",
        startDate: "2026-08-11T09:00:00Z",
        endDate: "2026-08-11T10:30:00Z",
      });

      const { result: query } = renderHook(
        () => useGetMergedLeaseCostHistory(mockCostHistoryLeaseId, range),
        { wrapper: createQueryClientWrapper() },
      );

      await waitFor(() => expect(query.current.isSuccess).toBe(true));

      expect(Object.fromEntries(queries[0]!)).toEqual({
        afterTimestamp: "2026-08-11T09:00:00.000Z",
        beforeTimestamp: "2026-08-11T10:30:00.001Z",
        maxResults: "100",
      });
      expect(query.current.data!.result).toEqual([result[1], result[2]]);
    });

    it("should drain every Bedrock token page", async () => {
      const { data } = createMockBedrockTokenCostHistory();
      const tokens = series(data.tokens[0]!, 250);
      server.use(
        leaseBedrockTokenHistoryGetHandler({
          status: "success",
          data: { ...data, tokens },
        }),
      );
      const queries = recordQueries("bedrockTokenHistory");

      const { result: query } = renderHook(
        () => useGetMergedLeaseBedrockTokenHistory(mockCostHistoryLeaseId),
        { wrapper: createQueryClientWrapper() },
      );

      await waitFor(() => expect(query.current.isSuccess).toBe(true));

      expect(queries).toHaveLength(3);
      expect(query.current.data).toEqual({
        result: tokens,
        nextPageIdentifier: null,
      });
    });

    it("should drain every breach page in full pages", async () => {
      const { data } = createMockCostHistory();
      const breaches = series(data.breaches[0]!, 250);
      server.use(
        leaseBreachHistoryGetHandler({
          status: "success",
          data: { ...data, breaches },
        }),
      );
      const queries = recordQueries("breachHistory");

      const { result: query } = renderHook(
        () => useGetMergedLeaseBreachHistory(mockCostHistoryLeaseId),
        { wrapper: createQueryClientWrapper() },
      );

      await waitFor(() => expect(query.current.isSuccess).toBe(true));

      expect(
        queries.map((asked) => [
          asked.get("maxResults"),
          asked.get("pageIdentifier"),
        ]),
      ).toEqual([
        ["100", null],
        ["100", "100"],
        ["100", "200"],
      ]);
      expect(query.current.data).toEqual({
        result: breaches,
        nextPageIdentifier: null,
      });
    });

    it("should keep each history's drain of one range under a key of its own", async () => {
      const { data } = createMockCostHistory();

      const { result } = renderHook(
        () => ({
          cost: useGetMergedLeaseCostHistory(mockCostHistoryLeaseId),
          breaches: useGetMergedLeaseBreachHistory(mockCostHistoryLeaseId),
        }),
        { wrapper: createQueryClientWrapper() },
      );

      await waitFor(() => {
        expect(result.current.cost.isSuccess).toBe(true);
        expect(result.current.breaches.isSuccess).toBe(true);
      });

      expect(result.current.cost.data!.result).toEqual(data.result);
      expect(result.current.breaches.data!.result).toEqual(data.breaches);
    });

    it("should return duration and expiry breaches from the breach drain", async () => {
      const costHistory = createMockLeaseEndBreachCostHistory();
      server.use(leaseBreachHistoryGetHandler(costHistory));

      const { result } = renderHook(
        () => useGetMergedLeaseBreachHistory(mockCostHistoryLeaseId),
        { wrapper: createQueryClientWrapper() },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data!.result).toEqual(costHistory.data.breaches);
    });
  });

  it("should read only the edited lease's cost summary again after a budget edit", async () => {
    server.use(
      http.patch(`${getConfig().ApiUrl}/leases/:id`, () =>
        HttpResponse.json({ status: "success" }, { status: 200 }),
      ),
    );
    const routes: CostRoute[] = [
      "costSummary",
      "costHistory",
      "bedrockTokenHistory",
      "breachHistory",
    ];
    const asked = Object.fromEntries(
      routes.map((route) => [route, recordQueries(route)]),
    );
    const counts = () =>
      Object.fromEntries(routes.map((route) => [route, asked[route]!.length]));
    const range = { afterTimestamp: "2026-08-11T00:00:00.000Z" };

    const { result } = renderHook(
      () => ({
        summary: useGetLeaseCostSummary(mockCostHistoryLeaseId),
        cost: useGetMergedLeaseCostHistory(mockCostHistoryLeaseId),
        tokens: useGetMergedLeaseBedrockTokenHistory(mockCostHistoryLeaseId),
        latest: useGetLeaseBedrockTokenHistory(mockCostHistoryLeaseId, {
          maxResults: 1,
        }),
        baseline: useGetLeaseBedrockTokenBaseline(
          mockCostHistoryLeaseId,
          range.afterTimestamp,
        ),
        breaches: useGetMergedLeaseBreachHistory(mockCostHistoryLeaseId),
        update: useUpdateLease(),
      }),
      { wrapper: createQueryClientWrapper() },
    );

    await waitFor(() => {
      expect(result.current.summary.isSuccess).toBe(true);
      expect(result.current.cost.isSuccess).toBe(true);
      expect(result.current.tokens.isSuccess).toBe(true);
      expect(result.current.latest.isSuccess).toBe(true);
      expect(result.current.baseline.isSuccess).toBe(true);
      expect(result.current.breaches.isSuccess).toBe(true);
    });
    // The token route serves the drain, the newest reading and the baseline.
    expect(counts()).toEqual({
      costSummary: 1,
      costHistory: 1,
      bedrockTokenHistory: 3,
      breachHistory: 1,
    });

    result.current.update.mutate({
      leaseId: mockCostHistoryLeaseId,
      maxSpend: 500,
    });

    await waitFor(() => expect(result.current.update.isSuccess).toBe(true));
    await waitFor(() => expect(counts()["costSummary"]).toBe(2));
    // The history rows do not change with the lease's settings, and the budget
    // lines come from the lease itself.
    expect(counts()).toEqual({
      costSummary: 2,
      costHistory: 1,
      bedrockTokenHistory: 3,
      breachHistory: 1,
    });
  });
});
