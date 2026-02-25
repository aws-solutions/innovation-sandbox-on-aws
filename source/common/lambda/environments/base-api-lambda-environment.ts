// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { z } from "zod";

export const BaseApiLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    JWT_SECRET_NAME: z.string(),
  });

export type BaseApiLambdaEnvironment = z.infer<
  typeof BaseApiLambdaEnvironmentSchema
>;
