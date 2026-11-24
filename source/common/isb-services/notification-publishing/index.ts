// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export { publish } from "./notification-publishing.service.js";
export type { NotificationFailureContext } from "./notification-publishing.service.js";

export {
  synthesizeNotificationMessages,
  toPublishMessage,
} from "./notification-message-synthesis.js";
export type {
  NotificationRoutingProps,
  SynthesizedAudienceMessage,
} from "./notification-message-synthesis.js";

export {
  resolveAdminRecipients,
  resolveAssignmentRecipients,
  resolveManagerRecipients,
  resolveUserRecipients,
} from "./recipient-resolvers.js";

export { NOTIFICATION_SCHEMA_VERSION } from "./notification-publishing.types.js";
export type {
  NotificationPublishMessage,
  NotificationPublishingServiceProps,
  RecipientPersona,
} from "./notification-publishing.types.js";
