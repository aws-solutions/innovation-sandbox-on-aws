// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import { getUserEmail } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

export async function allManagers(idcService: IdcService) {
  const managers = await collect(
    stream(idcService, idcService.listIsbManagers, {}),
  );
  return Array.from(new Set(managers.map((manager) => getUserEmail(manager))));
}

export async function allAdmins(idcService: IdcService) {
  const admins = await collect(
    stream(idcService, idcService.listIsbAdmins, {}),
  );
  return Array.from(new Set(admins.map((admin) => getUserEmail(admin))));
}

export async function union(...recipients: (string[] | Promise<string[]>)[]) {
  // NOSONAR typescript:S4123 — Promise.all correctly resolves the mixed
  // (string[] | Promise<string[]>) arguments; the finding is a false positive.
  const resolvedArrays = await Promise.all(recipients); // NOSONAR
  return Array.from(new Set(resolvedArrays.flat()));
}
