// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ApiProxy,
  IApiProxy,
} from "@amzn/innovation-sandbox-frontend/helpers/ApiProxy";

import {
  Blueprint,
  BlueprintDetailResponse,
  BlueprintListResponse,
  RegisterBlueprintRequest,
  StackSetListResponse,
  UpdateBlueprintRequest,
} from "./types";

export class BlueprintService {
  private api: IApiProxy;

  constructor(apiProxy?: IApiProxy) {
    this.api = apiProxy ?? new ApiProxy();
  }

  async getBlueprints(): Promise<BlueprintListResponse> {
    const response = await this.api.get<BlueprintListResponse>("/blueprints");
    return response;
  }

  async getBlueprintById(id: string): Promise<BlueprintDetailResponse> {
    const response = await this.api.get<BlueprintDetailResponse>(
      `/blueprints/${id}`,
    );
    return response;
  }

  async registerBlueprint(
    blueprint: RegisterBlueprintRequest,
  ): Promise<Blueprint> {
    const response = await this.api.post<Blueprint>("/blueprints", blueprint);
    return response;
  }

  async updateBlueprint(
    id: string,
    updates: UpdateBlueprintRequest,
  ): Promise<Blueprint> {
    const response = await this.api.put<Blueprint>(
      `/blueprints/${id}`,
      updates,
    );
    return response;
  }

  async unregisterBlueprint(id: string): Promise<void> {
    await this.api.delete(`/blueprints/${id}`);
  }

  async unregisterBlueprints(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.api.delete(`/blueprints/${id}`);
    }
  }

  async listStackSets(params?: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<StackSetListResponse> {
    let url = "/blueprints/stacksets";

    if (params) {
      const queryParams = new URLSearchParams();
      if (params.pageIdentifier) {
        queryParams.append("pageIdentifier", params.pageIdentifier);
      }
      if (params.pageSize) {
        queryParams.append("pageSize", params.pageSize.toString());
      }
      const queryString = queryParams.toString();
      if (queryString) {
        url = `${url}?${queryString}`;
      }
    }

    const response = await this.api.get<StackSetListResponse>(url);
    return response;
  }
}
