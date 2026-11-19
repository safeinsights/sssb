---
'@sssb/create': patch
'@sssb/tools': patch
'@sssb/kit': patch
---

### SSSB's adoption guide is short, with a reference beside it

**Kind.** none

**Action.** none

**What changed.** SSSB's `docs/adopting.md` is now a short guide in the order you act: generate, first boot, take out
the starter's content, a first entity, deploy and cut over, upgrade by release. Everything else it held is in
`docs/adopting-reference.md`. `sssb remove-items`, when it refuses, now points at the reference's "To remove the Items
slice" for the steps by hand. A new workspace's `README.md` links both, the guide's "Upgrading by release" for
the steps and the reference's "Upgrading, step by step" for why each is there.
