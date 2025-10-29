// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

import { commonConfig } from "./vite.config.js";

export default defineConfig({
  ...commonConfig,
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/setupTests.tsx"],
    include: ["test/**/*.test.{ts,tsx}"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      reporter: ["lcov", "text"],
      include: ["src/domains/**/*.{ts,tsx}"],
    },
  },
});
