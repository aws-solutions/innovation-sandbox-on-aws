// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { enumErrorMap } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import { z } from "zod";

export const IsbRoleSchema = z.enum(["Admin", "Manager", "User"], {
  errorMap: enumErrorMap,
});
export const IsbUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().optional(),
  userName: z.string().optional(),
  userId: z.string().optional(),
  roles: z.array(IsbRoleSchema).optional(),
});

export type IsbRole = z.infer<typeof IsbRoleSchema>;
export type IsbUser = z.infer<typeof IsbUserSchema>;

export type JSendResponse =
  | JSendSuccessResponse
  | JSendFailResponse
  | JSendErrorResponse;

export type JSendSuccessResponse = {
  status: "success";
  data: JSendData;
};

export type JSendFailResponse = {
  status: "fail";
  data: JSendData;
};

export type JSendErrorResponse = {
  status: "error";
  message: string;
  data?: JSendData;
};

export type JSendData = Record<string, any> & { errors?: JSendErrorObject[] };

export type JSendErrorObject = {
  field?: string;
  message: string;
};

export const SSM_PARAM_NAME_PREFIX = "/InnovationSandbox";
export const SSM_PARAM_NAME_PREFIX_SIMPLE = "InnovationSandbox";
export const SECRET_NAME_PREFIX = "/InnovationSandbox";

export function sharedAccountPoolSsmParamName(namespace: string) {
  return `${SSM_PARAM_NAME_PREFIX_SIMPLE}_${namespace}_AccountPool_Configuration`;
}

export function sharedDataSsmParamName(namespace: string) {
  return `${SSM_PARAM_NAME_PREFIX_SIMPLE}_${namespace}_Data_Configuration`;
}

export function sharedIdcSsmParamName(namespace: string) {
  return `${SSM_PARAM_NAME_PREFIX_SIMPLE}_${namespace}_Idc_Configuration`;
}
