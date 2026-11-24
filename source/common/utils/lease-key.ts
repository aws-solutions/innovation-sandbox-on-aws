// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { base64DecodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  LeaseKeySchema,
  type LeaseKey,
} from "@amzn/innovation-sandbox-shared/types/lease.js";

/** Decodes a client-supplied base64url lease key; undefined when malformed. */
export function parseLeaseKey(leaseId: string): LeaseKey | undefined {
  let decoded: unknown;
  try {
    decoded = base64DecodeCompositeKey(leaseId);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
  const parsed = LeaseKeySchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}
