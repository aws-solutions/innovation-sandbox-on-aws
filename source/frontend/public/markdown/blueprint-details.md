---
title: Blueprint Details
---

This page shows detailed information about a registered blueprint, including deployment health metrics and recent deployment history.

---

**Blueprint overview**

View basic information about the blueprint:

- **Blueprint ID**: Unique identifier
- **Created By**: Admin who registered the blueprint
- **Tags**: Organizational tags for categorization

---

**Health metrics**

Track blueprint reliability with deployment metrics:

- **Total Deployments**: Number of times this blueprint has been deployed to sandbox accounts
- **Deployment Success**: Successful deployments out of total attempts (e.g., "8 / 10" means 80% success rate)
- **Last Deployment**: When the blueprint was most recently deployed

Use these metrics to assess blueprint reliability. Low success rates may indicate issues with the StackSet template or deployment configuration.

---

**Recent deployments**

View the deployment history showing:

- **Lease ID**: Which lease triggered the deployment
- **Account ID**: Target sandbox account
- **Status**: Deployment result (Succeeded, Failed, Running, Queued)
- **Started**: When deployment began
- **Duration**: How long the deployment took

Select a deployment to view detailed CloudFormation stack instance information.

---

**StackSet details**

View the CloudFormation StackSet configuration (read-only):

- **StackSet ID**: CloudFormation StackSet identifier
- **Administration Role**: IAM role used for deployment orchestration
- **Execution Role**: IAM role used in target accounts
- **Regions**: AWS regions where resources are deployed
- **Region Order**: Deployment sequence (important for sequential deployments)

_Note: You cannot change the StackSet after registration. To use a different StackSet, register a new blueprint._

---

**Deployment settings**

View deployment configuration:

- **Deployment Timeout**: Maximum time to wait for deployment completion
- **Region Concurrency Type**: Sequential (one at a time) or Parallel (multiple regions)

To update these settings, you'll need to unregister and re-register the blueprint with new configuration.

---

**Update blueprint**

You can update:

- **Name and tags**: Edit basic details
- **Deployment configuration**: Update timeout and concurrency settings (future)

You cannot update:

- **StackSet**: Immutable after registration
- **Regions**: Defined by StackSet configuration

---

**Unregister blueprint**

To unregister this blueprint, choose **Actions** > **Unregister**.

**Before unregistering**: Remove the blueprint from any lease templates that reference it. Existing leases with deployed resources are not affected.
