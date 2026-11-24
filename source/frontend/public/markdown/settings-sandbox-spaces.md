---
title: Sandbox Spaces
---

Control whether lease templates can offer a Sandbox Space and which Amazon Bedrock models are available. In a Sandbox Space, users interact with their sandbox account through an AI agent.

## Availability

Turn on **Enable Sandbox Spaces** to make Spaces available in lease templates. Managers choose whether to enable Spaces for each template.

When you turn it off, Spaces on existing leases become unavailable. Conversations and the enabled model list are kept for when you turn it back on.

Turning Spaces off prevents new agent turns. It does not cancel running tasks, which may continue making AWS calls while their leases remain active.

Spaces always use Amazon Bedrock token monitoring, even when [**Allow Bedrock token monitoring**](/settings#setting-leases-allowBedrockTokenMonitoring) is off. Turning Spaces off does not change that deployment-wide setting.

## Permission sets

The agent acts with the permission set assigned to each user on the lease. Permission sets that have a permissions boundary are not supported for Sandbox Spaces. This covers both AWS managed and customer managed boundaries. When a user's permission set has a boundary, the agent rejects their messages, but their normal IAM Identity Center access to the sandbox account remains available. To give the user Sandbox Spaces access, assign a permission set that has no permissions boundary.

## Models

The **Models** table shows enabled models. At least one model must be enabled before users can start a conversation.

- **Add models**: Choose eligible models on the **Add Sandbox Spaces models** page. You can also re-enable models that were previously disabled.
- **Disable**: Select models, choose **Disable** from **Actions**, and choose **Save changes** to apply the changes. **Cancel** discards model changes you have not saved.

Disabling a model keeps the model lists on existing templates, but users can no longer select it in a Space. To make it available again, choose **Add models**.

Managers can view models but cannot add or disable them.

### Pricing

Prices are on-demand list prices in USD per 1,000 tokens. They are the rates used to estimate the cost of agent turns.

Each price comes from one of two sources, checked in this order:

1. **Price List**: The AWS Price List for Amazon Bedrock in the deployment Region. ISB uses this source whenever the Price List publishes a rate for the model.
2. **Agreement offers**: The Amazon Bedrock model agreement offers for the model. ISB uses this source only for models that the Price List does not price.

A model that neither source prices has no price. It appears on the **Add Sandbox Spaces models** page with its selection box disabled, and it cannot be added.

## Budget controls

Sandbox Spaces invokes Bedrock using credentials from the lease's sandbox account, so model inference is billed to that account and reaches the lease budget through the account's billed cost. When Bedrock token monitoring is enabled for the lease, its monitored token cost supplements that billed view. When the spend reaches a configured threshold or the lease's maximum spend, the normal freeze or terminate actions apply.
