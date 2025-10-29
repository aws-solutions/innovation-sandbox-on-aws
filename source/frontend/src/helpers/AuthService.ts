// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IsbUser } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";

type AuthResponse = {
  authenticated: boolean;
  session: {
    user: IsbUser;
    exp: number;
    iat: number;
  };
};

// constants
const JwtTokenStorageKey = "isb-jwt";
const AuthLoginStatusUrl = `${config.ApiUrl}/auth/login/status`;
const AuthLogoutUrl = `${config.ApiUrl}/auth/logout`;
const AuthLoginUrl = `${config.ApiUrl}/auth/login`;

export class AuthService {
  private static currentUser?: IsbUser;

  static async getCurrentUser(): Promise<IsbUser | undefined> {
    // if user already retrieved, return result from in memory
    if (this.currentUser) {
      return this.currentUser;
    }

    const currentToken = this.getAccessToken();

    if (!currentToken) {
      console.info("No access token found.");
      return undefined;
    }

    try {
      // call API to get user details
      const response = await fetch(AuthLoginStatusUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${currentToken}`,
          "Content-Type": "application/json",
        },
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(
          `${response.status} HTTP Error. There was an error checking if the user is already logged in.`,
        );
      }

      const data = (await response.json()) as AuthResponse;

      if (data.authenticated) {
        this.currentUser = data.session.user;

        // the token is valid, so save it to session storage
        sessionStorage.setItem(JwtTokenStorageKey, currentToken);

        return this.currentUser;
      }

      // User is not authenticated
      return undefined;
    } catch (err) {
      console.error("Error authenticating user", err);
      throw err;
    }
  }

  static getAccessToken(): string | null {
    // Retrieve the JWT token from sessionStorage
    const storedToken = sessionStorage.getItem(JwtTokenStorageKey);

    // Check if JWT token is present in URL
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");

    // if URL token is supplied, use that, otherwise fall back to stored token
    const currentToken = urlToken ?? storedToken;

    return currentToken;
  }

  static logout() {
    sessionStorage.removeItem(JwtTokenStorageKey);
    window.location.href = AuthLogoutUrl;
  }

  static login() {
    window.location.href = AuthLoginUrl;
  }
}
