// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { http, HttpResponse } from "msw";

import { GlobalConfigForUI } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { Lease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { SandboxAccount } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { UnregisteredAccount } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";
import { BlueprintWithStackSets } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  ApiFailResponse,
  ApiPaginatedResult,
  ApiResponse,
  ApiSuccessResponse,
} from "@amzn/innovation-sandbox-frontend/types";

class MockApi<T> {
  private mockData: T | T[] | null = null;
  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  returns(data: T | T[] | null) {
    this.mockData = data;
  }

  private handleUnregisteredAccounts() {
    return http.get(`${config.ApiUrl}/accounts/unregistered`, () => {
      if (this.mockData === null) {
        return new HttpResponse(null, { status: 404 });
      }

      const responseData: ApiResponse<ApiPaginatedResult<T>> = {
        status: "success",
        data: {
          result: Array.isArray(this.mockData)
            ? this.mockData
            : [this.mockData],
          nextPageIdentifier: null,
        },
      };

      return HttpResponse.json(responseData);
    });
  }

  private handleConfigurations() {
    const responseData: T = this.mockData as T;
    return this.createSuccessResponse(responseData);
  }

  private handleSingleResource(result: T[]) {
    const singleItem = result[0] as T;
    return this.createSuccessResponse(singleItem);
  }

  private handlePaginatedResult(result: T[]) {
    const paginatedData: ApiPaginatedResult<T> = {
      result: result,
      nextPageIdentifier: null,
    };
    return this.createSuccessResponse(paginatedData);
  }

  private createSuccessResponse(
    data: any,
  ): HttpResponse<ApiSuccessResponse<typeof data>> {
    const response: ApiSuccessResponse<typeof data> = {
      status: "success",
      data: data,
    };
    return HttpResponse.json(response);
  }

  private validateRequest(
    request: Request,
  ): HttpResponse<ApiFailResponse> | null {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new HttpResponse(null, { status: 401 });
    }
    return null;
  }

  private filterResults(
    result: T[],
    request: Request,
    params: { id?: string },
  ): T[] {
    let filteredResult = [...result];

    const url = new URL(request.url);
    const userEmail = url.searchParams.get("userEmail");

    if (params.id) {
      filteredResult = filteredResult.filter(
        (item: any) =>
          item.uuid === params.id ||
          item.blueprintId === params.id ||
          item.blueprint?.blueprintId === params.id,
      );
    }

    if (userEmail) {
      filteredResult = filteredResult.filter(
        (item: any) => item.userEmail === userEmail,
      );
    }

    return filteredResult;
  }

  getHandler(subPath: string = "") {
    if (this.endpoint === "/accounts/unregistered") {
      return this.handleUnregisteredAccounts();
    }

    return http.get(
      `${config.ApiUrl}${this.endpoint}${subPath}`,
      async ({ request, params }) => {
        if (this.mockData === null) {
          return new HttpResponse(null, { status: 404 });
        }

        const authError = this.validateRequest(request);
        if (authError) return authError;

        const result = Array.isArray(this.mockData)
          ? this.mockData
          : [this.mockData];
        const filteredResult = this.filterResults(result, request, params);

        if (this.endpoint === "/configurations") {
          return this.handleConfigurations();
        }

        if (subPath.includes(":id")) {
          return this.handleSingleResource(filteredResult);
        }

        return this.handlePaginatedResult(filteredResult);
      },
    );
  }

  postHandler(subPath: string = "") {
    return http.post(`${config.ApiUrl}${this.endpoint}${subPath}`, () => {
      if (this.mockData === null) {
        return new HttpResponse(null, { status: 404 });
      }

      const response: ApiResponse<T> = {
        status: "success",
        data: Array.isArray(this.mockData) ? this.mockData[0] : this.mockData,
      };

      return HttpResponse.json(response);
    });
  }

  deleteHandler(subPath: string = "") {
    return http.delete(
      `${config.ApiUrl}${this.endpoint}${subPath}`,
      ({ params }) => {
        if (Array.isArray(this.mockData)) {
          this.mockData = this.mockData.filter(
            (item: any) => item.uuid !== params.id,
          );
        }
        return HttpResponse.json({ status: "success" });
      },
    );
  }

  patchHandler(subPath: string = "") {
    return http.patch(
      `${config.ApiUrl}${this.endpoint}${subPath}`,
      async ({ request, params }) => {
        if (this.mockData === null) {
          return new HttpResponse(null, { status: 404 });
        }

        const requestBody = (await request.json()) as Record<string, any>;

        let updatedData: T | T[];
        if (Array.isArray(this.mockData)) {
          updatedData = this.mockData.map((item: any) => {
            if (item.uuid === params?.id) {
              return { ...item, ...requestBody };
            }
            return item;
          });
          this.mockData = updatedData;
        } else {
          updatedData = { ...this.mockData, ...requestBody } as T;
          this.mockData = updatedData;
        }

        const response: ApiResponse<T> = {
          status: "success",
          data: Array.isArray(updatedData)
            ? (updatedData.find((item: any) => item.uuid === params?.id) as T)
            : updatedData,
        };

        return HttpResponse.json(response);
      },
    );
  }

  putHandler(subPath: string = "") {
    return http.put(`${config.ApiUrl}${this.endpoint}${subPath}`, () => {
      if (this.mockData === null) {
        return new HttpResponse(null, { status: 404 });
      }

      const response: ApiResponse<T> = {
        status: "success",
        data: Array.isArray(this.mockData) ? this.mockData[0] : this.mockData,
      };

      return HttpResponse.json(response);
    });
  }

  reviewHandler(subPath: string = "") {
    return http.post(
      `${config.ApiUrl}${this.endpoint}${subPath}`,
      async ({ request }) => {
        if (this.mockData === null) {
          return new HttpResponse(null, { status: 404 });
        }

        const requestBody = (await request.json()) as Record<string, any>;
        const { leaseIds, approve } = requestBody;

        if (Array.isArray(this.mockData)) {
          this.mockData = this.mockData.map((item: any) => {
            if (leaseIds.includes(item.leaseId)) {
              return {
                ...item,
                status: approve ? "Active" : "Denied",
              };
            }
            return item;
          });
        }

        const response: ApiResponse<T> = {
          status: "success",
          data: null as any,
        };

        return HttpResponse.json(response);
      },
    );
  }
}

export const mockLeaseApi = new MockApi<Lease>("/leases");
export const mockLeaseTemplateApi = new MockApi<LeaseTemplate>(
  "/leaseTemplates",
);
export const mockConfigurationApi = new MockApi<GlobalConfigForUI>(
  "/configurations",
);
export const mockUnregisteredAccountApi = new MockApi<UnregisteredAccount>(
  "/accounts/unregistered",
);
export const mockAccountApi = new MockApi<SandboxAccount>("/accounts");
export const mockBlueprintApi = new MockApi<BlueprintWithStackSets>(
  "/blueprints",
);
