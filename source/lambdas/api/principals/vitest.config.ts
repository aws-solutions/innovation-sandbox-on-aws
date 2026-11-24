// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: [
      path.resolve(__dirname, "../../../common/test/lambdas/api-test-setup.ts"),
    ],
    coverage: {
      include: ["*.ts"],
    },
  },
  resolve: {
    alias: {
      "@amzn/innovation-sandbox-principals-handler": path.resolve(
        __dirname,
        "./src",
      ),
      "@amzn/innovation-sandbox-principals-handler/test": path.resolve(
        __dirname,
        "./test",
      ),
    },
  },
});
