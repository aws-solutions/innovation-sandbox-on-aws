// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import { NewLeaseTemplate } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/types";
import {
  ApiProxy,
  IApiProxy,
} from "@amzn/innovation-sandbox-frontend/helpers/ApiProxy";
import { ApiPaginatedResult } from "@amzn/innovation-sandbox-frontend/types";

export class LeaseTemplateService {
  private api: IApiProxy;

  constructor(apiProxy?: IApiProxy) {
    this.api = apiProxy ?? new ApiProxy();
  }

  async getLeaseTemplates(): Promise<LeaseTemplate[]> {
    let allLeaseTemplates: LeaseTemplate[] = [];
    let nextPageIdentifier: string | null = null;

    // keep calling the API until all lease templates are collected
    do {
      const url: string = nextPageIdentifier
        ? `/leaseTemplates?pageIdentifier=${nextPageIdentifier}`
        : "/leaseTemplates";

      const response =
        await this.api.get<ApiPaginatedResult<LeaseTemplate>>(url);

      allLeaseTemplates = [...allLeaseTemplates, ...response.result];
      nextPageIdentifier = response.nextPageIdentifier;
    } while (nextPageIdentifier !== null);

    return allLeaseTemplates;
  }

  async getLeaseTemplateById(id: string): Promise<LeaseTemplate | undefined> {
    const leaseTemplate = await this.api.get<LeaseTemplate | undefined>(
      `/leaseTemplates/${id}`,
    );
    return leaseTemplate;
  }

  async addLeaseTemplate(leaseTemplate: NewLeaseTemplate): Promise<void> {
    await this.api.post(`/leaseTemplates`, leaseTemplate);
  }

  async updateLeaseTemplate(leaseTemplate: LeaseTemplate): Promise<void> {
    const { uuid, blueprintName, ...rest } = leaseTemplate;
    await this.api.put(`/leaseTemplates/${uuid}`, rest);
  }

  async deleteLeaseTemplates(leaseTemplateIds: string[]): Promise<void> {
    for (const id of leaseTemplateIds) {
      await this.api.delete(`/leaseTemplates/${id}`);
    }
  }
}
