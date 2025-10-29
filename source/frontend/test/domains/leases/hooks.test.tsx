// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import {
  useLeasesForCurrentUser,
  useRequestNewLease,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { NewLeaseRequest } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { mockLease } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

vi.mock("@amzn/innovation-sandbox-frontend/helpers/AuthService", () => ({
  AuthService: {
    getCurrentUser: vi.fn().mockResolvedValue({ email: "test@example.com" }),
    getAccessToken: vi.fn().mockReturnValue("mocked-access-token"),
  },
}));

describe("Lease hooks", () => {
  describe("useLeasesForCurrentUser", () => {
    it("should fetch leases successfully", async () => {
      server.use(
        http.get(`${config.ApiUrl}/leases`, () => {
          return HttpResponse.json({
            status: "success",
            data: { result: [mockLease], nextPageIdentifier: null },
          });
        }),
      );

      const { result } = renderHook(() => useLeasesForCurrentUser(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data).toEqual([mockLease]);
    });

    it("should handle error when fetching leases fails", async () => {
      server.use(
        http.get(`${config.ApiUrl}/leases`, () => {
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
        http.post(`${config.ApiUrl}/leases`, async ({ request }) => {
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
        http.post(`${config.ApiUrl}/leases`, () => {
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
});
