-- 028: gmail content principal idiom — names → principal UUIDs.
--
-- The 2026-09-29 native-cognition pre-holdout cleanup found that
-- gmail_messages.principal_id held principal NAMES ('josctl', the persist
-- default) while every reader (searchGmailContentByKeyword /
-- getGmailMessageContent / listGmailThreadContent) filters by the
-- caller's principal UUID — gmail content search/read silently returned
-- zero rows in production. Align existing rows to the UUID idiom;
-- persistGmailContent now resolves the owner UUID when the sync lane
-- omits it.

UPDATE gmail_messages
   SET principal_id = (SELECT id::text FROM principals WHERE name = 'josctl')
 WHERE principal_id = 'josctl'
   AND EXISTS (SELECT 1 FROM principals WHERE name = 'josctl');
