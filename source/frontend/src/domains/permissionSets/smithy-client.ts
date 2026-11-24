// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ListPermissionSetsCommandInput,
  ListPermissionSetsCommandOutput,
} from "@amzn/innovation-sandbox-api-client";
import {
  IsbClient,
  ListPermissionSetsCommand,
} from "@amzn/innovation-sandbox-api-client";
import {
  type PermissionSetView,
  PermissionSetViewSchema,
} from "@amzn/innovation-sandbox-frontend/domains/permissionSets/model";
import { normalizeSmithyError } from "@amzn/innovation-sandbox-frontend/helpers/isbApiClient";
import { toValidListItems } from "@amzn/innovation-sandbox-frontend/helpers/validListItems";

export { createIsbClient as createPermissionSetsClient } from "@amzn/innovation-sandbox-frontend/helpers/isbApiClient";

export type PermissionSetListParams = Pick<
  ListPermissionSetsCommandInput,
  "maxResults" | "pageIdentifier" | "q"
>;

type GeneratedPermissionSetPage = NonNullable<
  ListPermissionSetsCommandOutput["data"]
>;

export type PermissionSetPage = Omit<GeneratedPermissionSetPage, "result"> & {
  result: PermissionSetView[];
};

export interface SmithyPermissionSetsApi {
  listPermissionSets(
    params?: PermissionSetListParams,
    abortSignal?: AbortSignal,
  ): Promise<PermissionSetPage>;
}

export class SmithyPermissionSetsClient implements SmithyPermissionSetsApi {
  constructor(private readonly client: IsbClient) {}

  async listPermissionSets(
    params: PermissionSetListParams = {},
    abortSignal?: AbortSignal,
  ): Promise<PermissionSetPage> {
    try {
      const output = await this.client.send(
        new ListPermissionSetsCommand(params),
        { abortSignal },
      );
      if (output.status !== "success" || !output.data?.result) {
        throw new Error("Permission sets response did not contain data");
      }

      return {
        result: toValidListItems({
          clientName: "SmithyPermissionSetsClient",
          getItemId: (item) =>
            item.permissionSetId ?? item.permissionSetArn ?? undefined,
          items: output.data.result,
          itemType: "permission set",
          mapItem: (item) => item,
          schema: PermissionSetViewSchema,
        }),
        nextPageIdentifier: output.data.nextPageIdentifier,
      };
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }
}
