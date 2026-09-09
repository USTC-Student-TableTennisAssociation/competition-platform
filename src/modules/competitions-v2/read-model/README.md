# Formal V2 competition read models

The match-detail and grouping dispatchers support all six formal
`SINGLE/DOUBLE/TEAM × group_only/group_then_knockout` combinations. They first
read the Match discriminator and then select the type-specific V2 projection.
No V2 projection falls back to legacy `Registration`, `MatchResult`, or JSON
payload facts.

## Snapshot and discrimination rules

Callers exhaustively handle not-found, Legacy, unsupported quick-match, and
type-specific V2 results. Each V2 aggregate is loaded in a read-only
`RepeatableRead` callback so Entries, roster history, relational grouping,
Fixtures, qualification standings, dependencies, revisions, administrative
resolutions, and settlements come from one database snapshot. Read callbacks
never auto-finish a match or perform reconciliation, audit, notification, or
settlement writes.

## Stable identities

- Competitors and action values use `entryId`; `userId` remains an account and
  profile identity.
- Match-ups use `fixtureId` plus `fixtureVersion`. Labels, array positions, and
  human-readable names are never command identities.
- Result actions use the persisted `revisionId` and immutable
  `revisionNumber`; clients do not reconstruct a revision from score text or
  time.
- A pending correction is the current action target while its confirmed
  predecessor remains the authoritative displayed result until the correction
  is accepted.
- Fixture sides resolve the exact frozen `sideARosterVersion` and
  `sideBRosterVersion`. Historical display names come from the frozen roster;
  current account fields are used only where the UI labels them as current.

## Relational phase projection

Published groups come from `MatchGrouping`, `MatchGroup`, `MatchGroupEntry`,
GROUP Fixtures, and frozen lineup rows. Group standings and qualifiers come
from one immutable `MatchQualificationSnapshot`; KNOCKOUT Fixtures are linked
through explicit qualifier or winner Dependencies. `NO_CONTEST` and
`ADMIN_BYE` are rendered from their relational administrative-resolution row,
not invented as a score.

The projections fail closed on duplicate active revisions, orphan corrections,
invalid Entry/source or roster snapshots, incomplete round robins, malformed
qualification ordering, impossible knockout dependencies, lifecycle drift, or
polluted metadata.

## Display metadata

Fixture `metadata` is an internal, versioned extension seam. Public readers
allow only the `v2Display.tableLabels` namespace in addition to the immutable
publication keys. A group must have identical labels on every Fixture; a
knockout Fixture owns its own labels. Raw metadata is never exposed to the
client, and label writes require a complete optimistic Fixture snapshot plus a
manager-authorized, audited command.

Seed ELO and points are frozen relationally when grouping is published. Current
profile ELO/points and current reporter/verifier names remain explicitly
current UI data; adding immutable reporter-name snapshots or customizable
round names would require a new schema and read contract.
