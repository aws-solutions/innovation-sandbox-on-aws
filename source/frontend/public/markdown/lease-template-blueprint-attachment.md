---
title: Attaching Blueprints to Lease Templates
---

_Note: This content will be added when blueprint attachment functionality is implemented in lease template pages._

---

**Attach a blueprint to a lease template**

To make a blueprint available to users:

1. Go to **Lease Templates**
2. Create a new template or edit an existing one
3. In the blueprint section, choose **Select blueprint**
4. Select a blueprint from available options
5. Save your changes

Users who request leases from that template will automatically receive the blueprint resources in their sandbox accounts.

---

**How blueprint deployment works**

When a user requests a lease from a template with an attached blueprint:

1. User selects the lease template (they don't see the blueprint directly)
2. Manager approves the request (if required)
3. System assigns a sandbox account
4. **Blueprint deploys automatically** before user receives access
5. User receives account with pre-configured infrastructure

If blueprint deployment fails, the lease is automatically terminated and the user is notified.

---

**Remove a blueprint from a template**

To remove a blueprint attachment:

1. Edit the lease template
2. In the blueprint section, choose **Remove blueprint**
3. Save your changes

_Note: Removing a blueprint only affects new leases. Existing leases keep their deployed resources._

---

**Best practices**

- **Test blueprints first**: Verify blueprint deploys successfully before attaching to public templates
- **Monitor health metrics**: Check blueprint success rates on the Blueprints page
- **Communicate to users**: Update template description to mention pre-configured resources
- **Consider deployment time**: Blueprint deployment adds time to lease provisioning (typically 5-30 minutes)

---

**Troubleshooting**

**Blueprint not available**: Verify the blueprint is registered and has ACTIVE status.

**Deployment failures**: Check blueprint health metrics and StackSet configuration.

**Users not receiving resources**: Verify blueprint is attached to the correct template and deployment succeeded.
