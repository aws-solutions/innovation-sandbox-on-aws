// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { accountHandlers } from "@amzn/innovation-sandbox-frontend/mocks/handlers/accountHandlers";
import { blueprintHandlers } from "@amzn/innovation-sandbox-frontend/mocks/handlers/blueprintHandlers";
import { configurationHandlers } from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { leaseHandlers } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseHandlers";
import { leaseTemplateHandlers } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { sandboxAgentHandlers } from "@amzn/innovation-sandbox-frontend/mocks/handlers/sandboxAgentHandlers";

export const handlers = [
  ...leaseHandlers,
  ...leaseTemplateHandlers,
  ...configurationHandlers,
  ...accountHandlers,
  ...blueprintHandlers,
  ...sandboxAgentHandlers,
];
