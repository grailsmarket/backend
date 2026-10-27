-- 'migrated' activity: a v1 name moving to the ENSv2 ETHRegistry.
--
-- ALTER TYPE ... ADD VALUE can't be used in the same transaction that adds it, so this is
-- its own file. Run it on its own (not inside BEGIN/COMMIT with other migrations).

ALTER TYPE activity_event_type ADD VALUE IF NOT EXISTS 'migrated';
