-- Two-layer spending policy: Layer-2 settings (per-category caps, allowed hours/weekdays, time zone, pre-charge delay)
-- plus a pending policy for the 24 h cool-down on loosening. Existing rows keep their values and get the defaults.
-- maxQuantity is dropped: it only mirrored the Layer-1 max-units-per-line rule, nothing reads it, and the previous
-- migration (20261105130000_policy_precharge) has not shipped.

-- AlterTable
ALTER TABLE "SessionPolicy" DROP COLUMN "maxQuantity",
ADD COLUMN "perCategoryMaxJson" TEXT NOT NULL DEFAULT '{}',
ADD COLUMN "allowedStartHour" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "allowedEndHour" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN "allowedWeekdays" INTEGER[] DEFAULT ARRAY[0, 1, 2, 3, 4, 5, 6]::INTEGER[],
ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
ADD COLUMN "prechargeDelaySeconds" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN "pendingJson" TEXT,
ADD COLUMN "pendingEffectiveAt" TIMESTAMP(3);
