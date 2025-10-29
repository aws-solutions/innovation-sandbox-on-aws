// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { accountHandlers } from "@amzn/innovation-sandbox-frontend/mocks/handlers/accountHandlers";
import { authHandlers } from "@amzn/innovation-sandbox-frontend/mocks/handlers/authHandlers";
import { configurationHandlers } from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { leaseHandlers } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseHandlers";
import { leaseTemplateHandlers } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";

export const handlers = [
  ...authHandlers,
  ...leaseHandlers,
  ...leaseTemplateHandlers,
  ...configurationHandlers,
  ...accountHandlers,
];
