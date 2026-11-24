// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { MiddlewareObj } from "@middy/core";
import { Context } from "aws-lambda";

import { ConfigStore } from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  ConfigSchemas,
  ConfigSection,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

export type ContextWithConfig = Context & {
  globalConfig: GlobalConfig;
};

// Reuse the DynamoDB-backed store (and its client) across warm invocations.
let configStoreInstance: ConfigStore | undefined;

function assembleGlobalConfig(
  storedSections: Awaited<ReturnType<ConfigStore["getAllSections"]>>,
): GlobalConfig {
  const config = {} as GlobalConfig;
  for (const section of Object.keys(ConfigSchemas) as ConfigSection[]) {
    const stored = storedSections[section];
    if (stored) {
      // Strip the audit/metadata envelope; the `.strict()` section schemas
      // reject the `lastSavedBy`/`meta` keys that `getAllSections()` returns.
      const { lastSavedBy: _lastSavedBy, meta: _meta, ...fields } = stored;
      (config as Record<ConfigSection, unknown>)[section] =
        ConfigSchemas[section].parse(fields);
    } else {
      (config as Record<ConfigSection, unknown>)[section] = ConfigSchemas[
        section
      ].parse({});
    }
  }
  return config;
}

export function isbConfigMiddleware(): MiddlewareObj<
  unknown,
  any,
  Error,
  ContextWithConfig
> {
  const isbConfigMiddlewareBefore = async (request: any) => {
    configStoreInstance ??= IsbServices.configStore(request.context.env);
    const storedSections = await configStoreInstance.getAllSections();
    Object.assign(request.context, {
      globalConfig: assembleGlobalConfig(storedSections),
    });
  };

  return {
    before: isbConfigMiddlewareBefore,
  };
}
