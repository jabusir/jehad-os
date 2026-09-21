-- 0018 down: profiles are inert presentation data; drop guard → view → table.
DROP TRIGGER IF EXISTS interaction_profiles_write_guard_trigger ON interaction_profiles;
DROP FUNCTION IF EXISTS interaction_profiles_write_guard();
DROP VIEW IF EXISTS interaction_profiles_active;
DROP TABLE IF EXISTS interaction_profiles;
