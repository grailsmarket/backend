-- Fix renewal activity records that were created by the Controller NameRenewed handler
-- (which lacks a referrer param) before the RenewalReferred event could set the correct
-- platform. Joins against the renewals table to find the authoritative referrer and maps
-- it to the human-readable registration source.

UPDATE activity_history ah
SET platform = CASE r.referrer
    WHEN '0x0000000000000000000000007e491cde0fbf08e51f54c4fb6b9e24afbd18966d' THEN 'grails'
    WHEN '0x0000000000000000000000001c0ea438837302b4516ac3f380313061ec11760f' THEN 'snipezone'
    WHEN '0x000000000000000000000000efce7f86fd1efb0359a91c873e6dee9f98788713' THEN 'enstools'
    WHEN '0x0000000000000000000000009531c059098e3d194ff87febb587ab07b30b1306' THEN 'rotki'
    WHEN '0x000000000000000000000000f919a96d2970380b87917b04f02e6d3d08368b10' THEN 'vision'
  END,
  metadata = ah.metadata || jsonb_build_object(
    'referrer', r.referrer,
    'registration_source', CASE r.referrer
      WHEN '0x0000000000000000000000007e491cde0fbf08e51f54c4fb6b9e24afbd18966d' THEN 'grails'
      WHEN '0x0000000000000000000000001c0ea438837302b4516ac3f380313061ec11760f' THEN 'snipezone'
      WHEN '0x000000000000000000000000efce7f86fd1efb0359a91c873e6dee9f98788713' THEN 'enstools'
      WHEN '0x0000000000000000000000009531c059098e3d194ff87febb587ab07b30b1306' THEN 'rotki'
      WHEN '0x000000000000000000000000f919a96d2970380b87917b04f02e6d3d08368b10' THEN 'vision'
    END
  )
FROM renewals r
WHERE ah.event_type = 'renewal'
  AND ah.platform = 'blockchain'
  AND ah.transaction_hash = r.transaction_hash
  AND ah.ens_name_id = r.ens_name_id
  AND r.referrer IS NOT NULL
  AND r.referrer IN (
    '0x0000000000000000000000007e491cde0fbf08e51f54c4fb6b9e24afbd18966d',
    '0x0000000000000000000000001c0ea438837302b4516ac3f380313061ec11760f',
    '0x000000000000000000000000efce7f86fd1efb0359a91c873e6dee9f98788713',
    '0x0000000000000000000000009531c059098e3d194ff87febb587ab07b30b1306',
    '0x000000000000000000000000f919a96d2970380b87917b04f02e6d3d08368b10'
  );
