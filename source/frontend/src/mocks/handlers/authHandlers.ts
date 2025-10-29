// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { http, HttpResponse } from "msw";

import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";

// Mock authentication endpoints for cases where AuthService is not mocked
export const authHandlers = [
  // Mock login status endpoint
  http.get(`${config.ApiUrl}/auth/login/status`, ({ request }) => {
    const authHeader = request.headers.get("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new HttpResponse(null, { status: 401 });
    }

    return HttpResponse.json({
      authenticated: true,
      session: {
        user: {
          email: "test@example.com",
          roles: ["User"],
        },
        exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
        iat: Math.floor(Date.now() / 1000),
      },
    });
  }),

  // Mock login endpoint
  http.get(`${config.ApiUrl}/auth/login`, () => {
    return HttpResponse.redirect("/");
  }),

  // Mock logout endpoint
  http.get(`${config.ApiUrl}/auth/logout`, () => {
    return HttpResponse.redirect("/");
  }),
];
