// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { http, HttpResponse } from "msw";

import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";

/**
 * Default sandbox-agent route handlers — return empty lists so any component
 * that mounts without a per-test override gets a valid (empty) response rather
 * than an unhandled-request error or a perpetually-pending query.
 * Per-test `server.use(...)` calls override these via MSW's last-registered-wins order.
 */
export const sandboxAgentHandlers = [
  http.get(`${getConfig().ApiUrl}/sandboxAgent/models`, () =>
    HttpResponse.json({ status: "success", data: { models: [] } }),
  ),
  http.get(`${getConfig().ApiUrl}/sandboxAgent/usage`, () =>
    HttpResponse.json({ status: "success", data: { spendByUsers: [] } }),
  ),
  http.get(`${getConfig().ApiUrl}/configurations/agent/models`, () =>
    HttpResponse.json({ status: "success", data: { models: [] } }),
  ),
];
