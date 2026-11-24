// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig, loadEnv, ProxyOptions, UserConfig } from "vite";

import {
  buildDevProxy,
  PROXIED_PATHS,
  resolveApiProxyTarget,
} from "./vite/resolve-proxy-target";

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
export default defineConfig(async ({ command, mode }) => {
  let proxy: Record<string, ProxyOptions> | undefined;

  // Only resolve/proxy for the dev server — never during `vite build`.
  if (command === "serve") {
    // Read deployment settings from the repo-root .env (two levels up).
    const env = loadEnv(mode, path.resolve(__dirname, "..", ".."), "");
    const target = await resolveApiProxyTarget(env);
    if (target) {
      proxy = buildDevProxy(target);
      console.info(`[vite] Proxying ${PROXIED_PATHS.join(", ")} -> ${target}`);
    }
  }

  return {
    ...commonConfig,
    server: {
      proxy,
    },
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
  };
});
