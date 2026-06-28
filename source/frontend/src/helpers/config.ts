// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

type ConfigData = {
  ApiUrl: string;
  deploymentMode: string;
};

export const config: ConfigData = {
  ApiUrl: import.meta.env.VITE_API_URL ?? `${window.location.origin}/api`,
  deploymentMode: import.meta.env.VITE_DEPLOYMENT_MODE ?? "",
};

export const isDevMode = (): boolean => config.deploymentMode === "dev";
