// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { registerApiSingletonReset } from "@amzn/innovation-sandbox-frontend/helpers/apiSingletons";

import {
  createPermissionSetsClient,
  PermissionSetListParams,
  PermissionSetPage,
  SmithyPermissionSetsApi,
  SmithyPermissionSetsClient,
} from "./smithy-client";

export class PermissionSetService {
  constructor(
    private readonly api: SmithyPermissionSetsApi = new SmithyPermissionSetsClient(
      createPermissionSetsClient(),
    ),
  ) {}

  async listPermissionSets(
    params?: PermissionSetListParams,
    abortSignal?: AbortSignal,
  ): Promise<PermissionSetPage> {
    return this.api.listPermissionSets(params, abortSignal);
  }
}

let permissionSetService: PermissionSetService | undefined;

export function getPermissionSetService(): PermissionSetService {
  permissionSetService ??= new PermissionSetService();
  return permissionSetService;
}

registerApiSingletonReset(() => {
  permissionSetService = undefined;
});
