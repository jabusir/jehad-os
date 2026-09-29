-- Down-path for 028_gmail_principal_uuid (forward-only in intent; tested
-- during dev). Restores the exact set 028 rewrote: v1-owner rows carrying
-- the resolved UUID go back to the literal name the broken idiom stored.

UPDATE gmail_messages
   SET principal_id = 'josctl'
 WHERE principal_id = (SELECT id::text FROM principals WHERE name = 'josctl')
   AND EXISTS (SELECT 1 FROM principals WHERE name = 'josctl');
