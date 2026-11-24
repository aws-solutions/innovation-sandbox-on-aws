---
title: Add Lease Template
---

Create a lease template that defines conditions for sandbox account usage.

---

## Wizard steps

**Basic details**: Template name, description, availability for user lease requests, and approval requirements.

**Blueprint**: Choose whether leases start with a blueprint's resources already deployed. When enabled, select one blueprint for a ready-to-use environment; when disabled, users receive an empty account. Blueprint deployment typically adds 5-30 minutes to provisioning.

**Access and sharing**: When lease sharing is enabled globally, choose whether lease owners can manage access. Then add up to 20 permission sets available for assignments and set the default from the selected-permission-sets table. The default cannot be removed until another selected permission set replaces it.

**Sandbox Space**: Configure optional AI chat access and available models. Enabling it turns on Amazon Bedrock token monitoring in the next step.

**Budget**: Configure cost tracking, a maximum budget, budget thresholds, and spend rate thresholds. Amazon Bedrock token monitoring is required while Sandbox Spaces is enabled.

**Duration**: Time limits and duration-based thresholds.

**Cost reporting**: Assign to a cost allocation group for financial tracking.

**Review and submit**: Review all settings before creating the template.

---

_Note: Template changes only affect new leases._

For more information, see [Creating and managing lease templates](https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/manager-guide.html#creating-lease-templates) in the implementation guide.
