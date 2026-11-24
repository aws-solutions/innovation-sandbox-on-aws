---
title: Edit Sandbox Spaces
---

Control the Sandbox Spaces AI chat for this lease.

---

**Sandbox Spaces**: When enabled, the lease user can use the Sandbox Spaces AI chat to act on their sandbox account. When enabled, agent (chat) spend counts toward the lease budget. Enabling Sandbox Spaces turns on Bedrock token monitoring, which it requires. Disabling it keeps monitoring on, unless an administrator has turned off **Allow Bedrock token monitoring** in Settings, in which case monitoring is turned off too.

**Limit available models**: Off by default, so users can choose any model an administrator enables in Settings, including ones enabled later. Turn it on and use **Add models** to restrict this lease to the models you add; at least one model is needed.

**Default model**: The model selected when a user first opens the Space. Choose **Set as default** in the models table. With the limit on, the default must be one of the added models. A default that has since been disabled in Settings shows as Disabled; remove it or set another default.

---

_Note: These settings apply to this lease only and take effect on the next chat message. Sandbox Spaces also has to be enabled globally in Administration Settings. While it is disabled there, a lease already using it can disable it, but cannot enable it again until it is enabled globally._
