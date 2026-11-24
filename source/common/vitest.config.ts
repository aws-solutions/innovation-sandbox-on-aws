// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: [path.resolve(__dirname, "./test/lambdas/api-test-setup.ts")],
    coverage: {
      include: ["*.ts"],
    },
  },
  resolve: {
    alias: {
      "@amzn/innovation-sandbox-commons/data": path.resolve(
        __dirname,
        "./data",
      ),
      "@amzn/innovation-sandbox-commons/test": path.resolve(
        __dirname,
        "./test",
      ),
      "@amzn/innovation-sandbox-commons/utils": path.resolve(
        __dirname,
        "./utils",
      ),
    },
  },
});
