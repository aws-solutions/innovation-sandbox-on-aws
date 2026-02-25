// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { vi } from "vitest";

import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { ReportingConfig } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config.js";
import yaml from "js-yaml";

export const bulkStubEnv = (envVars: Record<string, string>) => {
  for (let [key, value] of Object.entries(envVars)) {
    vi.stubEnv(key, value);
  }
};

export const mockAppConfigMiddleware = (
  globalConfig: GlobalConfig,
  reportingConfig?: ReportingConfig,
) => {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    // Check if URL contains the reporting config profile ID
    const reportingProfileId = process.env.REPORTING_CONFIG_PROFILE_ID;
    if (reportingProfileId && url.includes(reportingProfileId)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(yaml.dump({ ...reportingConfig })),
      } as unknown as Response);
    } else {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(yaml.dump({ ...globalConfig })),
      } as unknown as Response);
    }
  });
};
