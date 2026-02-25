// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
  resolve: {
    alias: {
      "@amzn/innovation-sandbox-blueprint-deployment-orchestrator":
        path.resolve(__dirname, "./src"),
      "@amzn/innovation-sandbox-blueprint-deployment-orchestrator/test":
        path.resolve(__dirname, "./test"),
    },
  },
});
