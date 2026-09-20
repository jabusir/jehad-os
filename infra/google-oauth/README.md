# infra/google-oauth

Generic Google OAuth re-consent for any surface's scopes; tokens land in that
surface's Keychain services (`--refresh-service` defaults to `<access>-refresh`).
Refreshing can never escalate scopes — new scopes need one-time owner re-consent.
The OAuth client is shared: credentials come from the existing
`jehad-gcalendar-client` Keychain items; only token services differ per surface.

    # calendar write (equivalent to infra/calendar/reauthorize-write.sh)
    infra/google-oauth/reauthorize.sh \
      "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events" \
      --access-service jehad-gcalendar
    # gmail read-only
    infra/google-oauth/reauthorize.sh "https://www.googleapis.com/auth/gmail.readonly" \
      --access-service jehad-gmail

Flags: `--port` (default 8971), `--no-open` (skip browser). Redirect
`http://localhost:8971` is already registered on the shared Google client;
other ports need the redirect added there first. Exits non-zero if any
requested scope is not granted.
