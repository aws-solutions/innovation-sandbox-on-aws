// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, UserConfig } from "vite";

export const commonConfig: UserConfig = {
  resolve: {
    alias: {
      "@amzn/innovation-sandbox-frontend": path.resolve(__dirname, "./src"),
      "@amzn/innovation-sandbox-frontend-test": path.resolve(
        __dirname,
        "./test",
      ),
    },
  },
  plugins: [react()],
};

// https://vitejs.dev/config/
export default defineConfig({
  ...commonConfig,
  define: {
    global: {},
    SOLUTION_VERSION: JSON.stringify(process.env.npm_package_version),
  },
  build: {
    chunkSizeWarningLimit: 3000,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (
          warning.code === "UNRESOLVED_IMPORT" &&
          /file-loader\?esModule=false!\.\/src-noconflict\//.test(
            warning.message,
          )
        ) {
          // Suppress the warning for ace-builds file-loader imports
          return;
        }

        // Handle other warnings as usual
        defaultHandler(warning);
      },
    },
  },
});
