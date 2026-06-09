-- Drop the generated/free-form title. Match posts now use description as the primary text.
ALTER TABLE "MatchPost" DROP COLUMN "title";
