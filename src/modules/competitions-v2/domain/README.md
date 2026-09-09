# Competition V2 domain boundary

This directory is deliberately independent from Prisma, Next.js, Server
Actions, and UI components. It defines the rules that every V2 write path must
enforce before persistence.

Core invariants:

- A match is written by exactly one engine. `LEGACY -> V2` requires a verified
  migration and the legacy writer to be disabled; `V2 -> LEGACY` is not a data
  migration strategy.
- An entry kind is immutable. An entry can be withdrawn or disqualified without
  deleting its historical identity. Its source key is also immutable and uses a
  kind-specific `individual:`, `doubles:`, or `team:` prefix.
- Entry members can change only before the first fixture exists. Later team
  substitutions require a new roster version instead of modifying history.
- A fixture stage is immutable. Fixture status and result revision status have
  separate transition rules; a pending correction does not silently reopen or
  erase an already confirmed fixture.
- Only pending result revisions can be confirmed or rejected. Confirmed
  revisions can be superseded or voided; rejected, voided, and superseded
  revisions never reopen.
- Result settlement is represented by one aggregate apply event and at most one
  reversal event. Each event has one aggregate effect row per user, covering
  rating, points, and statistics together.
