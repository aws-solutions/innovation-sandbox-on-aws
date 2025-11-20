---
title: Settings
---

The **Settings** page displays your Innovation Sandbox settings.

You cannot modify any settings directly using the web UI. To modify them, this solution uses [AWS AppConfig](https://docs.aws.amazon.com/appconfig/latest/userguide/what-is-appconfig.html) accessible through the UI. For more information, refer to the [Manage settings](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/administrator-guide.html#manage-settings) page in the User guide.

The **General Settings** tab displays maintenance mode settings, Regions managed by the solution, and Terms of Service.
Admins can turn on the **Maintenance Mode** when they want to deploy, modify, delete, or upgrade the solution to a newer version.

- When Maintenance mode is turned ON, managers and sandbox users will temporarily lose access to the UI, while Admins can still access the UI.
- After the completion of routine maintenance/administrative tasks, Admins can turn the Maintenance mode to OFF, to allow managers and sandbox users to resume using the UI. The default setting is OFF for Maintenance mode.

The **Lease Settings** tab displays the maximum values for budget, lease duration, and leases per user. Individual lease templates created by managers cannot have budget or lease duration that exceeds the global settings. For example, if the Admin sets a global setting for **Max Budget** as $500, then a lease template created by managers cannot have a budget higher than $500.

The **Clean Up Settings** tab displays the default values for clean-up processes, and Admins can modify these clean-up settings using **AWS AppConfig**.
