// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 30_000,
    setupFiles: [
      path.resolve(__dirname, "../../../common/test/lambdas/api-test-setup.ts"),
    ],
    coverage: {
      include: ["src/**/*.ts"],
    },
  },
  resolve: {
    alias: {
      "@amzn/innovation-sandbox-agent-connect": path.resolve(
        __dirname,
        "./src",
      ),
      "@amzn/innovation-sandbox-agent-connect/test": path.resolve(
        __dirname,
        "./test",
      ),
    },
  },
});
