// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { http, HttpResponse } from "msw";

import {
  SandboxAccountView,
  UnregisteredAccountView,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/model";
import { BlueprintWithStackSetsView } from "@amzn/innovation-sandbox-frontend/domains/blueprints/model";
import { LeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { LeaseTemplateView } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";
import { AdminConfigurationView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  ApiFailResponse,
  ApiPaginatedResult,
  ApiResponse,
  ApiSuccessResponse,
} from "@amzn/innovation-sandbox-frontend/types";
import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

// `ALGORITHM_IDENTIFIER` from @smithy/signature-v4. Inlined because the
// @smithy/signature-v4 version transitively pulled in by
// @aws-sdk/signature-v4@3.374.0 doesn't re-export `./constants`, so the
// constant isn't reachable via the public package entry; pinning the literal
// avoids reaching into a transitive dependency's internals.
const SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";

class MockApi<T> {
  private mockData: T | T[] | null = null;
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  returns(data: T | T[] | null) {
    this.mockData = data;
  }

  private handleUnregisteredAccounts() {
    return http.get(`${getConfig().ApiUrl}/accounts/unregistered`, () => {
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
    const singleItem = result[0];
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
    // SigV4-signed requests carry an `Authorization: AWS4-HMAC-SHA256 ...`
    // header AND an `x-isb-identity` ID-token header. Mock dev server only
    // checks both are present — signature is not verified locally.
    const authHeader = request.headers.get("Authorization");
    const identityHeader = request.headers.get(IDENTITY_HEADER);
    if (
      !authHeader ||
      !authHeader.startsWith(SIGV4_ALGORITHM) ||
      !identityHeader
    ) {
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
      `${getConfig().ApiUrl}${this.endpoint}${subPath}`,
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
    return http.post(`${getConfig().ApiUrl}${this.endpoint}${subPath}`, () => {
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
      `${getConfig().ApiUrl}${this.endpoint}${subPath}`,
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
      `${getConfig().ApiUrl}${this.endpoint}${subPath}`,
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
          updatedData = { ...this.mockData, ...requestBody };
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
    return http.put(`${getConfig().ApiUrl}${this.endpoint}${subPath}`, () => {
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
      `${getConfig().ApiUrl}${this.endpoint}${subPath}`,
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

export const mockLeaseApi = new MockApi<LeaseView>("/leases");
export const mockLeaseTemplateApi = new MockApi<LeaseTemplateView>(
  "/leaseTemplates",
);
export const mockConfigurationApi = new MockApi<AdminConfigurationView>(
  "/configurations",
);
export const mockUnregisteredAccountApi = new MockApi<UnregisteredAccountView>(
  "/accounts/unregistered",
);
export const mockAccountApi = new MockApi<SandboxAccountView>("/accounts");
export const mockBlueprintApi = new MockApi<BlueprintWithStackSetsView>(
  "/blueprints",
);
