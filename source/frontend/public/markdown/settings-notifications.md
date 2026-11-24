---
title: Notifications
---

Choose where lease, budget, and account notifications are delivered.

## Email

Turn on **Email notifications (SES)** to send email through Amazon Simple Email Service (Amazon SES).

For **Email from address (SES)**, use an address covered by a verified Amazon SES identity. If your deployment specifies a sending identity, use an address covered by that identity.

Email is not sent when email notifications are off or the sender address is empty.

## Amazon SNS

Turn on **SNS integration topic** to publish notifications to the deployment's shared Amazon Simple Notification Service (Amazon SNS) topic. Applications subscribed to this topic can process the notifications.

## When changes apply

Changes affect future notifications, including those for existing leases.

If both channels are off, users and managers are not notified about approvals, budget thresholds, or expiring leases.
