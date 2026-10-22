// Anonymous read-only tournament and ledger audit.
export const AUDIT_SQL = String.raw`
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
SELECT jsonb_build_object(
  'readOnly', current_setting('transaction_read_only'),
  'postgresMajorVersion', current_setting('server_version_num')::integer / 10000,
  'counts', jsonb_build_object(
    'users', (SELECT count(*) FROM "User"),
    'matches', (SELECT count(*) FROM "Match"),
    'registrations', (SELECT count(*) FROM "Registration"),
    'groupingPublications', (SELECT count(*) FROM "MatchGrouping"),
    'entries', (SELECT count(*) FROM match_entry),
    'entryMembers', (SELECT count(*) FROM match_entry_member),
    'groups', (SELECT count(*) FROM match_group),
    'groupMemberships', (SELECT count(*) FROM match_group_entry),
    'fixtures', (SELECT count(*) FROM match_fixture),
    'groupFixtures', (SELECT count(*) FROM match_fixture WHERE stage = 'GROUP'),
    'knockoutFixtures', (SELECT count(*) FROM match_fixture WHERE stage = 'KNOCKOUT'),
    'fixtureLineups', (SELECT count(*) FROM match_fixture_lineup_member),
    'fixtureDependencies', (SELECT count(*) FROM match_fixture_dependency),
    'fixtureAdministrativeResolutions', (SELECT count(*) FROM match_fixture_administrative_resolution),
    'resultRevisions', (SELECT count(*) FROM result_revision),
    'settlementEvents', (SELECT count(*) FROM settlement_event),
    'settlementEffects', (SELECT count(*) FROM settlement_effect),
    'pointsTransactions', (SELECT count(*) FROM "PointsTransaction"),
    'eloHistory', (SELECT count(*) FROM "EloHistory"),
    'legacyQualificationSnapshots', (SELECT count(*) FROM match_qualification_snapshot),
    'legacyQualificationStandings', (SELECT count(*) FROM match_qualification_standing),
    'knockoutSchedules', (SELECT count(*) FROM match_knockout_schedule),
    'groupQualificationSnapshots', (SELECT count(*) FROM match_group_qualification_snapshot),
    'groupQualificationStandings', (SELECT count(*) FROM match_group_qualification_standing)
  ),
  'men', jsonb_build_object(
    'matches', (SELECT count(*) FROM "Match" WHERE id = 'cmuxw9liu000swlp2m44ihhi3'),
    'groupingPublications', (SELECT count(*) FROM "MatchGrouping" WHERE "matchId" = 'cmuxw9liu000swlp2m44ihhi3'),
    'groups', (SELECT count(*) FROM match_group WHERE match_id = 'cmuxw9liu000swlp2m44ihhi3'),
    'groupMemberships', (SELECT count(*) FROM match_group_entry WHERE match_id = 'cmuxw9liu000swlp2m44ihhi3'),
    'entries', (SELECT count(*) FROM match_entry WHERE match_id = 'cmuxw9liu000swlp2m44ihhi3'),
    'entryMembers', (SELECT count(*) FROM match_entry_member WHERE match_id = 'cmuxw9liu000swlp2m44ihhi3'),
    'lateAdmissionEntries', (SELECT count(*) FROM match_entry WHERE match_id = 'cmuxw9liu000swlp2m44ihhi3' AND metadata ? 'v2LateAdmission'),
    'groupFixtures', (SELECT count(*) FROM match_fixture WHERE match_id = 'cmuxw9liu000swlp2m44ihhi3' AND stage = 'GROUP'),
    'knockoutFixtures', (SELECT count(*) FROM match_fixture WHERE match_id = 'cmuxw9liu000swlp2m44ihhi3' AND stage = 'KNOCKOUT'),
    'resultRevisions', (SELECT count(*) FROM result_revision WHERE match_id = 'cmuxw9liu000swlp2m44ihhi3'),
    'confirmedRevisions', (SELECT count(*) FROM result_revision WHERE match_id = 'cmuxw9liu000swlp2m44ihhi3' AND status = 'CONFIRMED'),
    'settlementEvents', (SELECT count(*) FROM settlement_event s WHERE EXISTS (SELECT 1 FROM match_entry e WHERE e.id = s.match_entry_id AND e.match_id = 'cmuxw9liu000swlp2m44ihhi3') OR EXISTS (SELECT 1 FROM result_revision r WHERE r.id = s.result_revision_id AND r.match_id = 'cmuxw9liu000swlp2m44ihhi3'))
  ),
  'women', jsonb_build_object(
    'matches', (SELECT count(*) FROM "Match" WHERE id = 'cmuxwaor20016wlp2swtr3pes'),
    'groups', (SELECT count(*) FROM match_group WHERE match_id = 'cmuxwaor20016wlp2swtr3pes'),
    'groupMemberships', (SELECT count(*) FROM match_group_entry WHERE match_id = 'cmuxwaor20016wlp2swtr3pes'),
    'groupFixtures', (SELECT count(*) FROM match_fixture WHERE match_id = 'cmuxwaor20016wlp2swtr3pes' AND stage = 'GROUP'),
    'knockoutFixtures', (SELECT count(*) FROM match_fixture WHERE match_id = 'cmuxwaor20016wlp2swtr3pes' AND stage = 'KNOCKOUT'),
    'resultRevisions', (SELECT count(*) FROM result_revision WHERE match_id = 'cmuxwaor20016wlp2swtr3pes'),
    'settlementEvents', (SELECT count(*) FROM settlement_event s WHERE EXISTS (SELECT 1 FROM match_entry e WHERE e.id = s.match_entry_id AND e.match_id = 'cmuxwaor20016wlp2swtr3pes') OR EXISTS (SELECT 1 FROM result_revision r WHERE r.id = s.result_revision_id AND r.match_id = 'cmuxwaor20016wlp2swtr3pes'))
  ),
  'userAggregates', (SELECT jsonb_build_object(
    'points', coalesce(sum(points), 0),
    'eloRating', coalesce(sum("eloRating"), 0),
    'wins', coalesce(sum(wins), 0),
    'losses', coalesce(sum(losses), 0),
    'matchesPlayed', coalesce(sum("matchesPlayed"), 0)
  ) FROM "User"),
  'supermarket', jsonb_build_object(
    'periods', (SELECT count(*) FROM supermarket_period),
    'settlements', (SELECT count(*) FROM supermarket_settlement),
    'prizes', (SELECT count(*) FROM supermarket_prize),
    'wallets', (SELECT count(*) FROM supermarket_balance),
    'walletLedgerEntries', (SELECT count(*) FROM supermarket_balance_entry),
    'redemptions', (SELECT count(*) FROM supermarket_redemption),
    'pendingRedemptions', (SELECT count(*) FROM supermarket_redemption WHERE status = 'PENDING')
  ),
  'migrations', jsonb_build_object(
    'successfulCount', (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
    'unfinishedCount', (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL),
    'latestSuccessfulName', (SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1),
    'progressiveMigrationApplied', EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261016180000_add_v2_progressive_knockout' AND finished_at IS NOT NULL AND rolled_back_at IS NULL)
  )
);
COMMIT;
`;
