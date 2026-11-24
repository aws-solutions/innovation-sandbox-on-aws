// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Construct } from "constructs";

/**
 * Local Vite dev server origin. In dev mode the Cognito app client also
 * registers localhost callback/logout URLs so the frontend can run locally
 * against the deployed API without manual Cognito changes.
 */
export const DEV_FRONTEND_ORIGIN = "http://localhost:5173";

/**
 * Loopback callbacks for the MCP app client's browser sign-in (IDE/CLI clients).
 * Cognito matches redirect URIs exactly, including the port, so every port the
 * MCP helper script may listen on is registered.
 */
export const MCP_CLIENT_CALLBACK_URLS = [29367, 29368, 29369].map(
  (port) => `http://localhost:${port}/callback`,
);

export function getDeploymentMode(scope: Construct): string {
  return scope.node.tryGetContext("deploymentMode") ?? "prod";
}

export function isDevMode(scope: Construct) {
  return getDeploymentMode(scope) === "dev";
}
