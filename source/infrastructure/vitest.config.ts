// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 300_000,
    // Hooks get the same budget as tests: the suites here build the frontend and
    // synthesize a stack in beforeAll, which exceeds the 10s hook default on a
    // slower CI host.
    hookTimeout: 300_000,
    coverage: {
      include: ["*.ts"],
    },
  },
  resolve: {
    alias: {
      "@amzn/innovation-sandbox-infrastructure": path.resolve(
        __dirname,
        "./lib",
      ),
      "@amzn/innovation-sandbox-infrastructure/test": path.resolve(
        __dirname,
        "./test",
      ),
      "@amzn/innovation-sandbox-lambda/account-lifecycle-management":
        path.resolve(
          __dirname,
          "../lambdas/account-management/account-lifecycle-management/src",
        ),
      "@amzn/innovation-sandbox-lambda/email-notification": path.resolve(
        __dirname,
        "../lambdas/notification/email-notification/src",
      ),
    },
  },
});
