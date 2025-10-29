// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GlobalConfigForUI } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { ReportingConfig } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config.js";
import {
  ApiProxy,
  IApiProxy,
} from "@amzn/innovation-sandbox-frontend/helpers/ApiProxy";

export class SettingService {
  private api: IApiProxy;

  constructor(apiProxy?: IApiProxy) {
    this.api = apiProxy ?? new ApiProxy();
  }

  async getConfigurations(): Promise<GlobalConfigForUI & ReportingConfig> {
    return this.api.get<GlobalConfigForUI & ReportingConfig>("/configurations");
  }
}
