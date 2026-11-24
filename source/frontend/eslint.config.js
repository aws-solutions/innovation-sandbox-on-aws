// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import reactRefreshPlugin from "eslint-plugin-react-refresh";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import globals from "globals";

export default [
  {
    ignores: ["dist", "coverage", "node_modules"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
      "react-refresh": reactRefreshPlugin,
      prettier: prettierPlugin,
      "simple-import-sort": simpleImportSort,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...prettierConfig.rules,
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@amzn/innovation-sandbox-commons/**"],
              message:
                "Frontend code must use the shared package or frontend-owned modules, not backend commons.",
            },
          ],
        },
      ],
      "prettier/prettier": [
        "warn",
        {
          semi: true,
          tabWidth: 2,
          trailingComma: "all",
        },
      ],
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          // Allow discarding server-owned fields via rest destructuring
          // (e.g. `const { lastSavedBy: _l, ...fields } = data`) without
          // flagging the extracted siblings. Deliberately NOT relaxing the
          // rule for arbitrary `_`-prefixed vars/args.
          ignoreRestSiblings: true,
        },
      ],
      "simple-import-sort/imports": [
        "warn",
        {
          groups: [
            [String.raw`^\u0000(?!\.)`],
            [String.raw`^(?!@amzn)(@?\w.*)`],
            ["^@amzn"],
            [String.raw`^\u0000\.`],
          ],
        },
      ],
      "simple-import-sort/exports": "warn",
      "react/react-in-jsx-scope": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },
];
