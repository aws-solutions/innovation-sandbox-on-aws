// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "@amzn/innovation-sandbox-frontend/App";
import { configureAmplifyAuth } from "@amzn/innovation-sandbox-frontend/helpers/cognito-config";
import { loadConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";

await loadConfig()
  .then((cfg) => {
    if (
      cfg.CognitoUserPoolId &&
      cfg.CognitoAppClientId &&
      cfg.CognitoIdentityPoolId &&
      cfg.CognitoDomain &&
      cfg.Region &&
      cfg.AwsAccessPortalUrl
    ) {
      configureAmplifyAuth({
        userPoolId: cfg.CognitoUserPoolId,
        appClientId: cfg.CognitoAppClientId,
        identityPoolId: cfg.CognitoIdentityPoolId,
        domain: cfg.CognitoDomain,
        region: cfg.Region,
        awsAccessPortalUrl: cfg.AwsAccessPortalUrl,
      });

      ReactDOM.createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
          <App />
        </React.StrictMode>,
      );
    } else {
      console.error(
        "Incomplete Cognito configuration — all of CognitoUserPoolId, CognitoAppClientId, CognitoIdentityPoolId, CognitoDomain, Region, and AwsAccessPortalUrl are required",
      );
      const root = document.getElementById("root");
      if (root) {
        root.textContent =
          "Authentication is not configured. Please contact your administrator.";
      }
    }
  })
  .catch((error) => {
    console.error("Failed to initialize application", error);
    const root = document.getElementById("root");
    if (root) {
      root.textContent =
        "Application failed to load. Please refresh the page or contact your administrator.";
    }
  });
