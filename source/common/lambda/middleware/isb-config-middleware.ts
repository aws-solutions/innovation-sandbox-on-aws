// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { MiddlewareObj } from "@middy/core";
import { Context } from "aws-lambda";
import { ZodObject } from "zod";

import {
  GlobalConfig,
  GlobalConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import {
  ReportingConfig,
  ReportingConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config.js";
import yaml from "js-yaml";

export type ContextWithConfig = Context & {
  globalConfig: GlobalConfig;
};

export type ContextWithReportingConfig = Context & {
  reportingConfig: ReportingConfig;
};

export type ContextWithGlobalAndReportingConfig = ContextWithConfig &
  ContextWithReportingConfig;

export class InvalidGlobalConfiguration extends Error {}
export class InvalidReportingConfiguration extends Error {}

async function fetchAndValidateConfig<T>(
  profileIdEnvVar: string,
  schema: ZodObject<any>,
  ErrorClass: new (message: string) => Error,
  configType: string,
): Promise<T> {
  const response = await fetch(
    `http://localhost:2772/applications/${process.env.APP_CONFIG_APPLICATION_ID}/environments/${process.env.APP_CONFIG_ENVIRONMENT_ID}/configurations/${process.env[profileIdEnvVar]}`,
  );

  if (!response.ok) {
    throw new Error(
      `Error retrieving ${configType} configuration: ${response.status}`,
    );
  }

  const config = yaml.load(await response.text());
  const parsedConfig = schema.strict().safeParse(config);

  if (!parsedConfig.success) {
    throw new ErrorClass(
      `Incorrect ${configType} configuration: ${parsedConfig.error}`,
    );
  }

  return parsedConfig.data as T;
}

export function isbConfigMiddleware(): MiddlewareObj<
  unknown,
  any,
  Error,
  ContextWithConfig
> {
  const isbConfigMiddlewareBefore = async (request: any) => {
    const globalConfig = await fetchAndValidateConfig(
      "APP_CONFIG_PROFILE_ID",
      GlobalConfigSchema,
      InvalidGlobalConfiguration,
      "global",
    );

    Object.assign(request.context, { globalConfig });
  };

  return {
    before: isbConfigMiddlewareBefore,
  };
}

export function isbReportingConfigMiddleware(): MiddlewareObj<
  unknown,
  any,
  Error,
  ContextWithReportingConfig
> {
  const isbReportingConfigMiddlewareBefore = async (request: any) => {
    const reportingConfig = await fetchAndValidateConfig(
      "REPORTING_CONFIG_PROFILE_ID",
      ReportingConfigSchema,
      InvalidReportingConfiguration,
      "reporting",
    );

    Object.assign(request.context, { reportingConfig });
  };

  return {
    before: isbReportingConfigMiddlewareBefore,
  };
}
