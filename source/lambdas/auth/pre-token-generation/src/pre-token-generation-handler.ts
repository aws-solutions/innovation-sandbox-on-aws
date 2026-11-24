// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { Context } from "aws-lambda";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  PreTokenGenerationEnvironment,
  PreTokenGenerationEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/pre-token-generation-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  COGNITO_IDC_DISPLAY_NAME_CLAIM,
  COGNITO_IDC_USER_ID_CLAIM,
  COGNITO_IDC_USER_NAME_CLAIM,
  COGNITO_ISB_ROLES_CLAIM,
  COGNITO_USERNAME_CLAIM,
  resolveEmailFromClaims,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

import type {
  PreTokenGenerationV2Event,
  PreTokenGenerationV2Response,
} from "@amzn/innovation-sandbox-pre-token-generation/types.js";

const logger = new Logger();
const tracer = new Tracer();

type PreTokenGenerationContext = Context &
  ValidatedEnvironment<PreTokenGenerationEnvironment>;

const preTokenGenerationHandler = async (
  event: PreTokenGenerationV2Event,
  context: PreTokenGenerationContext,
): Promise<PreTokenGenerationV2Event> => {
  const email = resolveEmailFromClaims({
    email: event.request.userAttributes.email,
    [COGNITO_USERNAME_CLAIM]: event.userName,
  });
  if (!email) {
    logger.error("No email found in user attributes or userName", {
      userName: event.userName,
    });
    throw new Error("Email could not be resolved from Cognito trigger event");
  }
  logger.info("Pre Token Generation trigger invoked", { email });

  const idcService = IsbServices.idcService(
    context.env,
    fromTemporaryIsbIdcCredentials(context.env),
  );

  const idcUser = await idcService.getUserFromEmail(email);
  if (!idcUser) {
    logger.error(
      "User was not found in IAM Identity Center — blocking token generation",
      { email },
    );
    throw new Error(
      "User could not be found in IAM Identity Center. Please contact your administrator to request access.",
    );
  }

  const roles = idcUser.roles ?? [];

  logger.debug("Resolved ISB roles", { email, roles });

  if (roles.length === 0) {
    logger.error(
      "User has no ISB group memberships — blocking token generation",
      {
        email,
      },
    );
    throw new Error(
      "User is not assigned to any ISB groups. Please contact your administrator to request access.",
    );
  }

  const rolesClaimValue = JSON.stringify(roles);
  const idcUserId = idcUser.userId;
  const identityClaims = {
    [COGNITO_ISB_ROLES_CLAIM]: rolesClaimValue,
    [COGNITO_IDC_USER_ID_CLAIM]: idcUserId,
    ...(idcUser.displayName
      ? { [COGNITO_IDC_DISPLAY_NAME_CLAIM]: idcUser.displayName }
      : {}),
    ...(idcUser.userName
      ? { [COGNITO_IDC_USER_NAME_CLAIM]: idcUser.userName }
      : {}),
  };

  const response: PreTokenGenerationV2Response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        claimsToAddOrOverride: identityClaims,
      },
    },
  };

  event.response = response;
  return event;
};

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: PreTokenGenerationEnvironmentSchema,
  moduleName: "pre-token-generation",
}).handler(preTokenGenerationHandler);
