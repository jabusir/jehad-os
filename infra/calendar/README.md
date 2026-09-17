# infra/calendar — Google Calendar read-only sensor (E3)

Jehad OS reads your Google Calendar as a **sensor**: it observes events and
records structured changes (`calendar.event.created | updated | cancelled`).
It NEVER creates, updates, or deletes anything in Google — Calendar stays
authoritative for the calendar event itself. (The read-only property is
adversarially pinned: `packages/adapters/src/source-adapters/google-calendar.test.ts`
asserts every issued call is `GET …/calendar/v3/calendars/{id}/events`.)

## Token bootstrap (owner, manual — no OAuth flow is implemented)

The adapter takes a `tokenProvider: () => Promise<string>`. The built-in
provider resolves in this order:

1. **Env override (dev):** `GCALENDAR_ACCESS_TOKEN` —
   `GCALENDAR_ACCESS_TOKEN=ya29.… pnpm dev` style invocations.
2. **macOS Keychain item:** service `jehad-gcalendar` —

   ```sh
   security add-generic-password -s jehad-gcalendar -a jehad -w 'PASTE_TOKEN_HERE'
   # read it back (this is what the adapter runs):
   security find-generic-password -s jehad-gcalendar -w
   ```

   The token itself never enters git, the database, logs, or event payloads
   (AGENTS.md hard rule). Delete with
   `security delete-generic-password -s jehad-gcalendar`.

### Obtaining a token manually (OAuth Playground, ~2 minutes)

Google OAuth Playground can mint a short-lived access token for dogfooding
(no client app, no refresh-token storage in v1):

1. Open <https://developers.google.com/oauthplayground/>.
2. Click the gear icon → check **Use your own OAuth credentials** is OFF, and
   set **OAuth flow type** to the default (Authorization code) — fine for
   Playground-issued tokens.
3. In step 1, paste `https://www.googleapis.com/auth/calendar.readonly` into
   the *Input your own scopes* box, click **Authorize APIs**, and complete
   the Google consent for the account whose calendar you want.
   (`calendar.readonly` is the least privilege this sensor needs.)
4. In step 2, click **Exchange authorization code for tokens** — copy the
   **Access token** (`ya29.…`).
5. Store it:

   ```sh
   security add-generic-password -s jehad-gcalendar -a jehad -w 'ya29.…'
   # or for a one-off dev run:
   export GCALENDAR_ACCESS_TOKEN='ya29.…'
   ```

Playground access tokens expire after ~1 hour; when they do the API returns
401 (`GoogleCalendarApiError`) — repeat step 4 and update the Keychain item.
A proper refresh-token flow (own GCP OAuth client, offline access) is a
deliberate v1 non-goal; flag it when dogfooding gets annoying.

## What the sensor stores

- `calendar_events` — the world-model projection (current believed state per
  event: status, title, calendar-native times, attendees **emails+names
  only**, sparse metadata). Every row carries `source_event_id` → the
  observation event that last updated it, so the event log can reconstruct
  WHY the world model believes each row. It is not a blob store: Google
  remains the source of truth, and only the fields we derive meaning from
  are projected.
- `calendar_sync_state` — the sync cursor (Google `syncToken`). A 410
  "token expired" response triggers an automatic full resync; identical
  content classifies as unchanged, so a resync never duplicates semantic
  effects.
- Observation events (`calendar.event.*`) carry
  `payload.changeClass` ∈ `created | cancelled | start_end_changed |
  attendees_changed | updated` with previous times where relevant — these
  feed whatChanged (attention) and the morning brief automatically.

## Owner call: today's schedule is MEANINGFUL

The morning brief's suppression predicate treats a non-empty today's
schedule as a real attention item: a day with meetings is not a calm-empty
day, so `todaySchedule.length > 0` alone un-suppresses the brief
(`isMorningBriefMeaningful`, pinned by golden tests). Calendar-native times
are the trusted tier (date-trust policy: resolutionMethod `calendar-native`).

v1 scope: personal domain, single calendar (`calendarId` — usually
`"primary"`). "Today" for the schedule section is the UTC day of the brief
timestamp.
