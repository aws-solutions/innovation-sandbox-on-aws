// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** SES identity ARN in any partition, capturing Region and identity. */
export const SES_IDENTITY_ARN_REGEX =
  /^arn:aws[a-zA-Z-]*:ses:([a-z0-9-]+):\d{12}:identity\/(.+)$/;
