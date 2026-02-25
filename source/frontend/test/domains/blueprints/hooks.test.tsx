// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import {
  useGetBlueprintById,
  useGetBlueprints,
  useListStackSets,
  useRegisterBlueprint,
  useUnregisterBlueprint,
  useUnregisterBlueprints,
  useUpdateBlueprint,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/hooks";
import {
  RegisterBlueprintRequest,
  UpdateBlueprintRequest,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  createBlueprint,
  createBlueprintWithStackSets,
  createStackSet,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/blueprintFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";

vi.mock("@amzn/innovation-sandbox-frontend/helpers/AuthService", () => ({
  AuthService: {
    getCurrentUser: vi.fn().mockResolvedValue({ email: "test@example.com" }),
    getAccessToken: vi.fn().mockReturnValue("mocked-access-token"),
  },
}));

describe("Blueprint hooks", () => {
  describe("useGetBlueprints", () => {
    it("should fetch blueprints successfully", async () => {
      const mockBlueprint = createBlueprintWithStackSets();
      server.use(
        http.get(`${config.ApiUrl}/blueprints`, () => {
          return HttpResponse.json({
            status: "success",
            data: {
              blueprints: [mockBlueprint],
              nextPageIdentifier: null,
            },
          });
        }),
      );

      const { result } = renderHook(() => useGetBlueprints(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data?.blueprints).toHaveLength(1);
      expect(result.current.data?.blueprints[0].blueprint.blueprintId).toBe(
        mockBlueprint.blueprint.blueprintId,
      );
    });

    it("should handle error when fetching blueprints fails", async () => {
      server.use(
        http.get(`${config.ApiUrl}/blueprints`, () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to fetch blueprints" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useGetBlueprints(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeDefined();
    });
  });

  describe("useGetBlueprintById", () => {
    it("should fetch blueprint by ID successfully", async () => {
      const mockBlueprint = createBlueprint();
      const blueprintId = mockBlueprint.blueprintId;

      server.use(
        http.get(`${config.ApiUrl}/blueprints/${blueprintId}`, () => {
          return HttpResponse.json({
            status: "success",
            data: {
              blueprint: mockBlueprint,
              stackSets: [],
              recentDeployments: [],
            },
          });
        }),
      );

      const { result } = renderHook(() => useGetBlueprintById(blueprintId), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data?.blueprint.blueprintId).toBe(blueprintId);
    });

    it("should not fetch when blueprintId is empty", async () => {
      const { result } = renderHook(() => useGetBlueprintById(""), {
        wrapper: createQueryClientWrapper(),
      });

      expect(result.current.isFetching).toBe(false);
      expect(result.current.data).toBeUndefined();
    });

    it("should handle error when fetching blueprint by ID fails", async () => {
      const blueprintId = "650e8400-e29b-41d4-a716-446655440001";

      server.use(
        http.get(`${config.ApiUrl}/blueprints/${blueprintId}`, () => {
          return HttpResponse.json(
            { status: "error", message: "Blueprint not found" },
            { status: 404 },
          );
        }),
      );

      const { result } = renderHook(() => useGetBlueprintById(blueprintId), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeDefined();
    });
  });

  describe("useRegisterBlueprint", () => {
    it("should register a new blueprint successfully", async () => {
      const { result } = renderHook(() => useRegisterBlueprint(), {
        wrapper: createQueryClientWrapper(),
      });

      const newBlueprintRequest: RegisterBlueprintRequest = {
        name: "New Blueprint",
        stackSetId: "ss-12345678-1234-1234-1234-123456789012",
        regions: ["us-east-1"],
        tags: { environment: "test" },
        deploymentTimeoutMinutes: 30,
      };

      let apiCallMade = false;
      server.use(
        http.post(`${config.ApiUrl}/blueprints`, async ({ request }) => {
          const body = await request.json();
          expect(body).toEqual(newBlueprintRequest);
          apiCallMade = true;
          return HttpResponse.json(
            {
              status: "success",
              data: createBlueprint({ name: newBlueprintRequest.name }),
            },
            { status: 200 },
          );
        }),
      );

      result.current.mutate(newBlueprintRequest);

      await waitFor(
        () => {
          expect(result.current.isSuccess).toBe(true);
        },
        { timeout: 5000 },
      );

      expect(apiCallMade).toBe(true);
      expect(result.current.isError).toBe(false);
    });

    it("should handle error when registering blueprint fails", async () => {
      server.use(
        http.post(`${config.ApiUrl}/blueprints`, () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to register blueprint" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useRegisterBlueprint(), {
        wrapper: createQueryClientWrapper(),
      });

      const newBlueprintRequest: RegisterBlueprintRequest = {
        name: "New Blueprint",
        stackSetId: "ss-12345678-1234-1234-1234-123456789012",
        regions: ["us-east-1"],
      };

      result.current.mutate(newBlueprintRequest);

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeDefined();
    });
  });

  describe("useUpdateBlueprint", () => {
    it("should update blueprint successfully", async () => {
      const blueprintId =
        "650e8400-e29b-41d4-a716-44665544000145678-1234-1234-1234-123456789012";
      const updates: UpdateBlueprintRequest = {
        name: "Updated Blueprint Name",
        tags: { environment: "production" },
        deploymentTimeoutMinutes: 45,
      };

      const { result } = renderHook(() => useUpdateBlueprint(), {
        wrapper: createQueryClientWrapper(),
      });

      let apiCallMade = false;
      server.use(
        http.put(
          `${config.ApiUrl}/blueprints/${blueprintId}`,
          async ({ request }) => {
            const body = await request.json();
            expect(body).toEqual(updates);
            apiCallMade = true;
            return HttpResponse.json(
              {
                status: "success",
                data: createBlueprint({ ...updates, blueprintId }),
              },
              { status: 200 },
            );
          },
        ),
      );

      result.current.mutate({ id: blueprintId, updates });

      await waitFor(
        () => {
          expect(result.current.isSuccess).toBe(true);
        },
        { timeout: 5000 },
      );

      expect(apiCallMade).toBe(true);
      expect(result.current.isError).toBe(false);
    });

    it("should handle error when updating blueprint fails", async () => {
      const blueprintId =
        "650e8400-e29b-41d4-a716-44665544000145678-1234-1234-1234-123456789012";
      const updates: UpdateBlueprintRequest = {
        name: "Updated Blueprint Name",
      };

      server.use(
        http.put(`${config.ApiUrl}/blueprints/${blueprintId}`, () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to update blueprint" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useUpdateBlueprint(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate({ id: blueprintId, updates });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeDefined();
    });
  });

  describe("useUnregisterBlueprint", () => {
    it("should unregister blueprint successfully", async () => {
      const blueprintId =
        "650e8400-e29b-41d4-a716-44665544000145678-1234-1234-1234-123456789012";

      const { result } = renderHook(() => useUnregisterBlueprint(), {
        wrapper: createQueryClientWrapper(),
      });

      let apiCallMade = false;
      server.use(
        http.delete(`${config.ApiUrl}/blueprints/${blueprintId}`, () => {
          apiCallMade = true;
          return HttpResponse.json({ status: "success" }, { status: 200 });
        }),
      );

      result.current.mutate(blueprintId);

      await waitFor(
        () => {
          expect(result.current.isSuccess).toBe(true);
        },
        { timeout: 5000 },
      );

      expect(apiCallMade).toBe(true);
      expect(result.current.isError).toBe(false);
    });

    it("should handle error when unregistering blueprint fails", async () => {
      const blueprintId =
        "650e8400-e29b-41d4-a716-44665544000145678-1234-1234-1234-123456789012";

      server.use(
        http.delete(`${config.ApiUrl}/blueprints/${blueprintId}`, () => {
          return HttpResponse.json(
            {
              status: "error",
              message: "Blueprint is attached to lease templates",
            },
            { status: 409 },
          );
        }),
      );

      const { result } = renderHook(() => useUnregisterBlueprint(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate(blueprintId);

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeDefined();
    });
  });

  describe("useUnregisterBlueprints", () => {
    it("should unregister multiple blueprints successfully", async () => {
      const blueprintIds = [
        "650e8400-e29b-41d4-a716-44665544000145678-1234-1234-1234-123456789012",
        "87654321-4321-4321-4321-210987654321",
      ];

      const { result } = renderHook(() => useUnregisterBlueprints(), {
        wrapper: createQueryClientWrapper(),
      });

      let apiCallCount = 0;
      server.use(
        http.delete(`${config.ApiUrl}/blueprints/:id`, () => {
          apiCallCount++;
          return HttpResponse.json({ status: "success" }, { status: 200 });
        }),
      );

      result.current.mutate(blueprintIds);

      await waitFor(
        () => {
          expect(result.current.isSuccess).toBe(true);
        },
        { timeout: 5000 },
      );

      expect(apiCallCount).toBe(2);
      expect(result.current.isError).toBe(false);
    });

    it("should handle error when unregistering multiple blueprints fails", async () => {
      const blueprintIds = [
        "650e8400-e29b-41d4-a716-44665544000145678-1234-1234-1234-123456789012",
        "87654321-4321-4321-4321-210987654321",
      ];

      server.use(
        http.delete(`${config.ApiUrl}/blueprints/:id`, () => {
          return HttpResponse.json(
            {
              status: "error",
              message: "Blueprint is attached to lease templates",
            },
            { status: 409 },
          );
        }),
      );

      const { result } = renderHook(() => useUnregisterBlueprints(), {
        wrapper: createQueryClientWrapper(),
      });

      result.current.mutate(blueprintIds);

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeDefined();
    });
  });

  describe("useListStackSets", () => {
    it("should list stacksets successfully", async () => {
      const mockStackSets = [
        createStackSet(),
        createStackSet({
          stackSetName: "AnotherStackSet",
          stackSetId: "ss-87654321-4321-4321-4321-210987654321",
        }),
      ];

      server.use(
        http.get(`${config.ApiUrl}/blueprints/stacksets`, () => {
          return HttpResponse.json({
            status: "success",
            data: {
              result: mockStackSets,
              nextPageIdentifier: null,
            },
          });
        }),
      );

      const { result } = renderHook(() => useListStackSets(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(result.current.data?.result).toHaveLength(2);
      expect(result.current.data?.result[0].stackSetName).toBe(
        mockStackSets[0].stackSetName,
      );
    });

    it("should list stacksets with pagination parameters", async () => {
      const mockStackSets = [createStackSet()];
      const params = { pageIdentifier: "next-page", pageSize: 10 };

      let requestUrl = "";
      server.use(
        http.get(`${config.ApiUrl}/blueprints/stacksets`, ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json({
            status: "success",
            data: {
              result: mockStackSets,
              nextPageIdentifier: null,
            },
          });
        }),
      );

      const { result } = renderHook(() => useListStackSets(params), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(requestUrl).toContain("pageIdentifier=next-page");
      expect(requestUrl).toContain("pageSize=10");
    });

    it("should handle error when listing stacksets fails", async () => {
      server.use(
        http.get(`${config.ApiUrl}/blueprints/stacksets`, () => {
          return HttpResponse.json(
            { status: "error", message: "Failed to list stacksets" },
            { status: 500 },
          );
        }),
      );

      const { result } = renderHook(() => useListStackSets(), {
        wrapper: createQueryClientWrapper(),
      });

      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(result.current.error).toBeDefined();
    });
  });
});
