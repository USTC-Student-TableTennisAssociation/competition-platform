import { CompetitionDomainError } from "./errors";
import type { EntryKind, EntryStatus } from "./values";

declare const entrySourceKeyBrand: unique symbol;
export type EntrySourceKey = string & {
  readonly [entrySourceKeyBrand]: true;
};

const ENTRY_SOURCE_PREFIX = {
  INDIVIDUAL: "individual",
  DOUBLES: "doubles",
  TEAM: "team",
} as const satisfies Record<EntryKind, string>;

export type ParsedEntrySourceKey = Readonly<{
  kind: EntryKind;
  sourceId: string;
}>;

export type EntryActivationInput = Readonly<{
  kind: EntryKind;
  memberIds: readonly string[];
  minimumTeamMembers?: number;
  maximumTeamMembers?: number;
}>;

export type EntryMembershipMutationContext = Readonly<{
  status: EntryStatus;
  hasFixture: boolean;
}>;

export type SuccessorRosterContext = Readonly<{
  kind: EntryKind;
  status: EntryStatus;
  hasFixture: boolean;
}>;

/** Creates the immutable legacy/source identity retained after a source is archived. */
export function createEntrySourceKey(kind: EntryKind, sourceId: string) {
  if (sourceId.trim() === "" || sourceId !== sourceId.trim()) {
    throw new CompetitionDomainError(
      "INVALID_ENTRY_SOURCE_KEY",
      "An entry source ID must be non-empty and contain no surrounding whitespace.",
      { kind },
    );
  }
  return `${ENTRY_SOURCE_PREFIX[kind]}:${sourceId}` as EntrySourceKey;
}

export function parseEntrySourceKey(sourceKey: string): ParsedEntrySourceKey {
  for (const kind of Object.keys(ENTRY_SOURCE_PREFIX) as EntryKind[]) {
    const prefix = `${ENTRY_SOURCE_PREFIX[kind]}:`;
    if (sourceKey.startsWith(prefix) && sourceKey.length > prefix.length) {
      const sourceId = sourceKey.slice(prefix.length);
      if (sourceId.trim() !== "" && sourceId === sourceId.trim()) {
        return { kind, sourceId };
      }
      break;
    }
  }

  throw new CompetitionDomainError(
    "INVALID_ENTRY_SOURCE_KEY",
    "Entry source keys must use an individual:, doubles:, or team: prefix.",
    { sourceKey },
  );
}

function assertPositiveInteger(value: number, name: string) {
  if (Number.isInteger(value) && value > 0) return;
  throw new CompetitionDomainError(
    "INVALID_ENTRY_MEMBERS",
    `${name} must be a positive integer.`,
    { [name]: value },
  );
}

/**
 * Validates the member snapshot required to activate an entry. Match-specific
 * team size rules are supplied by the caller instead of being hard-coded here.
 */
export function assertEntryCanActivate(input: EntryActivationInput) {
  const { kind, memberIds } = input;
  const invalidMemberId = memberIds.find(
    (memberId) => memberId.trim() === "" || memberId !== memberId.trim(),
  );
  if (invalidMemberId !== undefined) {
    throw new CompetitionDomainError(
      "INVALID_ENTRY_MEMBERS",
      "Entry members must have non-empty user IDs.",
      { kind },
    );
  }

  const uniqueMembers = new Set(memberIds);
  if (uniqueMembers.size !== memberIds.length) {
    throw new CompetitionDomainError(
      "INVALID_ENTRY_MEMBERS",
      "An entry cannot contain the same user more than once.",
      { kind, memberCount: memberIds.length },
    );
  }

  if (kind === "INDIVIDUAL" && memberIds.length !== 1) {
    throw new CompetitionDomainError(
      "INVALID_ENTRY_MEMBERS",
      "An individual entry must contain exactly one member.",
      { kind, memberCount: memberIds.length },
    );
  }

  if (kind === "DOUBLES" && memberIds.length !== 2) {
    throw new CompetitionDomainError(
      "INVALID_ENTRY_MEMBERS",
      "A doubles entry must contain exactly two distinct members.",
      { kind, memberCount: memberIds.length },
    );
  }

  if (kind !== "TEAM") return;

  const minimum = input.minimumTeamMembers ?? 1;
  const maximum = input.maximumTeamMembers;
  assertPositiveInteger(minimum, "minimumTeamMembers");
  if (maximum !== undefined) {
    assertPositiveInteger(maximum, "maximumTeamMembers");
    if (maximum < minimum) {
      throw new CompetitionDomainError(
        "INVALID_ENTRY_MEMBERS",
        "maximumTeamMembers cannot be lower than minimumTeamMembers.",
        { minimumTeamMembers: minimum, maximumTeamMembers: maximum },
      );
    }
  }

  if (memberIds.length < minimum || (maximum !== undefined && memberIds.length > maximum)) {
    throw new CompetitionDomainError(
      "INVALID_ENTRY_MEMBERS",
      "The team entry does not satisfy this match's roster limits.",
      {
        memberCount: memberIds.length,
        minimumTeamMembers: minimum,
        maximumTeamMembers: maximum ?? null,
      },
    );
  }
}

/**
 * Once any fixture references an entry, its member snapshot is historical
 * fact. Later substitutions must create a new roster version; they must not
 * mutate this snapshot in place.
 */
export function assertEntryMemberSnapshotMutationAllowed(
  context: EntryMembershipMutationContext,
) {
  if (context.hasFixture) {
    throw new CompetitionDomainError(
      "ENTRY_MEMBERSHIP_FROZEN",
      "Entry membership is frozen after its first fixture is created.",
      context,
    );
  }

  if (context.status === "DRAFT" || context.status === "ACTIVE") return;
  throw new CompetitionDomainError(
    "ENTRY_MEMBERSHIP_NOT_EDITABLE",
    `Entry membership cannot change while the entry is ${context.status}.`,
    context,
  );
}

/**
 * Only a team can receive a new roster version after fixtures exist. The
 * application layer must additionally enforce administrator authorization and
 * make the version effective only for future fixtures. Doubles and team entries
 * retain their competition slot; personal results stay bound to each fixture.
 */
export function assertSuccessorRosterCanBeCreated(
  context: SuccessorRosterContext,
) {
  if (
    (context.kind === "TEAM" || context.kind === "DOUBLES") &&
    context.status === "ACTIVE" &&
    context.hasFixture
  ) {
    return;
  }

  throw new CompetitionDomainError(
    "ENTRY_ROSTER_VERSION_NOT_ALLOWED",
    "A successor roster is allowed only for an active doubles/team entry with historical fixtures.",
    context,
  );
}
