---
name: Baileys runtime notes
description: Environment-specific package and runtime behavior for the WhatsApp QR connection.
---

The package firewall rejected the 6.x Baileys package from the uploaded bot, while the current 7.x release candidate installed successfully. The API build externalizes `protobufjs`, so it must be directly resolvable from the API server package at runtime.

**Why:** The first server restart failed after the package installed because Node could not resolve the externalized transitive dependency from the API package.

**How to apply:** If changing Baileys versions or the API bundle's external list, verify package availability through the firewall and make sure each external runtime dependency is directly available to `@workspace/api-server`.
