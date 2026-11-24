// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import {
  allAdmins,
  allManagers,
  union,
} from "@amzn/innovation-sandbox-commons/isb-services/notification/email-address-utils.js";

/** The SNS-path equivalent of `EmailService`'s inline `to: [user]` recipient logic: the single event-owning user. */
export function resolveUserRecipients(userEmail: string): string[] {
  return [userEmail];
}

/**
 * The SNS-path equivalent of `EmailService.sendNotificationEmail`'s inline
 * AssignmentCreated/AssignmentRemoved recipient logic: the required lease
 * owner plus the optional assignee, deduplicated.
 */
export function resolveAssignmentRecipients(
  leaseOwner: string,
  assigneeEmail?: string,
): string[] {
  return [...new Set([leaseOwner, ...(assigneeEmail ? [assigneeEmail] : [])])];
}

/**
 * The manager audience for most manager-audience events: the union of
 * admins and managers. Reuses the existing cached
 * `IdcService.listIsbAdmins()`/`listIsbManagers()` via the same
 * `allAdmins`/`allManagers` helpers the SES path already calls.
 */
export async function resolveManagerRecipients(
  idcService: IdcService,
): Promise<string[]> {
  const [admins, managers] = await Promise.all([
    allAdmins(idcService),
    allManagers(idcService),
  ]);
  return union(admins, managers);
}

/**
 * The admin-only audience for the small set of events that must not reach
 * managers (see `notification-message-synthesis.ts`). Unlike
 * `resolveManagerRecipients`, this never includes managers.
 */
export async function resolveAdminRecipients(
  idcService: IdcService,
): Promise<string[]> {
  return allAdmins(idcService);
}
