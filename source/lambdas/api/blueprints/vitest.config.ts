// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["*.ts"],
    },
  },
  resolve: {
    alias: {
      "@amzn/innovation-sandbox-blueprints-handler": path.resolve(
        __dirname,
        "./src",
      ),
      "@amzn/innovation-sandbox-blueprints-handler/test": path.resolve(
        __dirname,
        "./test",
      ),
    },
  },
});
