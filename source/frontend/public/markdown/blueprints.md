---
title: Blueprints
---

The **Blueprints** page displays all your registered blueprints with deployment health metrics.

A **blueprint** is a pre-configured infrastructure template that automatically deploys resources to sandbox accounts. Blueprints use AWS CloudFormation StackSets to provide users with ready-to-use environments.

**How blueprints work**: When you attach a blueprint to a lease template, the blueprint automatically deploys when users request leases from that template. Users receive accounts with pre-configured infrastructure instead of empty AWS accounts.

---

**Register a blueprint**

Admins can register CloudFormation StackSets as blueprints. Choose **Register blueprint** to start the registration wizard.

**Requirements**:

- StackSet must have **ACTIVE** status
- StackSet must use **SELF_MANAGED** permission model
- StackSet must be created in the same AWS account as Innovation Sandbox

For more information, refer to the [Managing blueprints](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/admin-guide.html#managing-blueprints) page.

---

**Health metrics**

The blueprints table shows deployment success metrics to help you assess reliability:

- **Successful Deployments**: Shows successful deployments out of total attempts (e.g., "5 / 10")
- **Recent**: Indicates if the blueprint was deployed recently
- **Last Updated**: When the blueprint configuration was last modified

Use these metrics to identify blueprints that may need updates or troubleshooting. Select a blueprint name to view detailed health metrics and deployment history.

---

**Unregister a blueprint**

To unregister a blueprint, select it from the table and choose **Actions** > **Unregister**.

**Before unregistering**: Remove the blueprint from any lease templates that reference it. Existing leases with deployed blueprint resources are not affected.

---

**Attach blueprints to lease templates**

See the [Lease Templates](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#attaching-blueprints) page for information about attaching blueprints to templates.

---

**Best practices**

- **Test blueprints** before attaching to public lease templates
- **Monitor health metrics** to identify reliability issues
- **Use descriptive names** to help managers choose the right blueprint
- **Add tags** to organize blueprints by use case or team
