// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LeaseWithLeaseId } from "@amzn/innovation-sandbox-commons/data/lease/lease";
import {
  LeasePatchRequest,
  MonitoredLeaseWithLeaseId,
  NewLeaseRequest,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import {
  ApiProxy,
  IApiProxy,
} from "@amzn/innovation-sandbox-frontend/helpers/ApiProxy";
import { ApiPaginatedResult } from "@amzn/innovation-sandbox-frontend/types";

export class LeaseService {
  private api: IApiProxy;

  constructor(apiProxy?: IApiProxy) {
    this.api = apiProxy ?? new ApiProxy();
  }

  async getLeases(userEmail?: string): Promise<LeaseWithLeaseId[]> {
    let allLeases: LeaseWithLeaseId[] = [];
    let nextPageIdentifier: string | null = null;

    // keep calling the API until all leases are collected
    do {
      let url: string = nextPageIdentifier
        ? `/leases?pageIdentifier=${nextPageIdentifier}`
        : "/leases";

      if (userEmail) {
        url +=
          (url.includes("?") ? "&" : "?") +
          `userEmail=${encodeURIComponent(userEmail)}`;
      }

      const response =
        await this.api.get<ApiPaginatedResult<LeaseWithLeaseId>>(url);

      allLeases = [...allLeases, ...response.result];
      nextPageIdentifier = response.nextPageIdentifier;
    } while (nextPageIdentifier !== null);

    return allLeases;
  }

  async getLeaseById(
    id: string,
  ): Promise<MonitoredLeaseWithLeaseId | undefined> {
    const lease = await this.api.get<MonitoredLeaseWithLeaseId | undefined>(
      `/leases/${id}`,
    );
    return lease;
  }

  async requestNewLease(request: NewLeaseRequest): Promise<void> {
    await this.api.post("/leases", request);
  }

  async updateLease(request: LeasePatchRequest): Promise<void> {
    const { leaseId, ...rest } = request;
    await this.api.patch(`/leases/${leaseId}`, rest);
  }

  async reviewLease(leaseId: string, approve: boolean): Promise<void> {
    await this.api.post(`/leases/${leaseId}/review`, {
      action: approve ? "Approve" : "Deny",
    });
  }

  async terminateLease(leaseId: string): Promise<void> {
    await this.api.post(`/leases/${leaseId}/terminate`);
  }

  async freezeLease(leaseId: string): Promise<void> {
    await this.api.post(`/leases/${leaseId}/freeze`);
  }

  async unfreezeLease(leaseId: string): Promise<void> {
    await this.api.post(`/leases/${leaseId}/unfreeze`);
  }
}
