---
title: General
---

Manage maintenance mode and the terms users accept when requesting a lease. View configuration set at deployment time.

Administrators can edit settings. Managers can view them.

## [Maintenance mode](/settings#setting-maintenance-enabled)

Turn on **Maintenance mode** while updating the deployment. Managers and users lose access to Innovation Sandbox, but administrators retain access. Existing sandbox accounts keep running.

New deployments start with maintenance mode on. To give managers and users access, turn it off and choose **Save changes**.

For more information, see [Managing maintenance mode](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/administrator-guide.html#maintenance-mode) in the implementation guide.

## [Terms of service](/settings#setting-termsOfService-content)

Enter the conditions users must accept before requesting a sandbox account in **Terms of service content**.

## Deployment settings

These values are configured at deployment time and cannot be changed on this page:

- **Solution version**: The installed version of Innovation Sandbox.
- **AWS access portal URL**: The sign-in portal for accessing AWS accounts.
- **Innovation Sandbox managed regions**: The AWS Regions managed by the solution.
- **Bedrock inference profile patterns**: The configured patterns for Amazon Bedrock cross-Region inference.

## Reviewing defaults

An information icon marks a section whose default settings need review. Review the values and choose **Save changes**, even if you keep the defaults.
