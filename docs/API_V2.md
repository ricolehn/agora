# API v2

API v2 hands out the data in the shapes of the database structure 4 ([DATABASE.md](DATABASE.md)). The old API (v1,
`/api/...`) stays as it is: every app version keeps working. `GET /api/status` lists the versions a server answers
(`"apiVersions": [1, 2]`).

## Stability

API v2 is stable: what it answers keeps its name, its type and its meaning, and what it takes stays taken. It only
grows - new resources, new fields in answers, new optional fields in a request, new values of a fixed choice (a new
`area` of the change log, a new kind of request, a new error code). So a client ignores fields it does not know and
takes a value of a choice it does not know as "other". Whatever would break a client comes as a new version next to
v2 (`/api/v3`), never as a change of v2.

## Conventions

- **Base:** `/api/v2`. Sign in as for v1 (`POST /api/auth/login`) and send the token: `Authorization: Bearer <token>`.
- **Ids** are the records' ids. **Money** is a whole number of cents (`amountCents: 2550` is 25.50). **Days** are
  `YYYY-MM-DD`, **moments** ISO 8601 in UTC (`2026-05-05T08:30:00.000Z`). Field names are camelCase.
- **Lists** come in pages, every one of them: `{ "items": [...], "nextCursor": "..." }`. Ask for the next page with
  `?cursor=<nextCursor>`; `nextCursor` is `null` on the last page. `?limit=` sets the page size (default 100, at most
  500 - more counts as 500). A page starts after the last item of the page before, so entries added meanwhile shift
  nothing. Every list has a fixed order (see the resources); "by name" and "by title" ignore case and accents
  ("Ärger" comes next to "Arger").
- **What a request sends** is JSON, and every value is checked: what does not fit is refused with `invalid` (400) -
  never cut or guessed. Money: a whole number of cents, at most 100,000,000,000 either way (negative for a
  correction). A day: a day of the calendar (`2026-02-31` is refused - in a body as in `?from=` and `?to=`). Texts:
  `description` and `rejectionReason` at most 500 characters, `donorName` and `issuer` 200. `receipt`: the name of a
  file in the receipts folder (`null` or `""` takes it away). An id: a record id. A `limit` or `cursor` that is none
  is refused, too. Fields a resource does not know are ignored.
- **Errors:** `{ "error": { "code": "...", "message": "..." } }` with the HTTP status - every error, also those of the
  sign-in, the limits and a server that is starting: `invalid` (400, also a body that is no JSON), `unauthorized`
  (401), `forbidden` (403), `not_found` (404), `conflict` (409), `too_large` (413), `rate_limited` (429),
  `server_error` (500), `unavailable` (503: the server is starting or updating its database - ask again after the
  seconds in `Retry-After`).
- **Permissions** are those of v1: the finances need *view finances* to read and *manage finances* to write; a member
  reads their own member record and requests.

## Changes and versions

Every change names the version of the data it is based on. If the data changed meanwhile, the change is refused with
`409 conflict` - read again and repeat the change. Nothing is overwritten unseen.

- A **payment** is part of its member's books: send `memberVersion` (the member's `version`; every payment in an answer
  carries the member's current one as `memberVersion`).
- **Donations** and **expenses** are lists: send `listVersion` (in the answer of every list read and every change).
- **Booked for a request** (`requestId` with a payment, a donation or an expense): the request is booked once,
  however often it is sent. Sent again - after an answer that got lost, say - it answers `200` with the booking that
  is there (a new booking answers `201`). With another member, amount or day it is no repetition and refused (`409`).
- A payment an older app wrote without an id of its own gets one with its first change through v2, and with it a new
  record id: take the `id` of the answer.

Changes made through v2 are the same changes as through the web app: the balances, the statistics and the
[change log](#finance) see them alike.

## Resources

| Method and path | What | Who |
| --- | --- | --- |
| `GET /api/v2` | the resources | signed in |
| `GET /me` | the signed-in person: id, name, e-mail, `isAdmin`, `isOwner`, `permissions`, `groups`, `language`, `timeZone` | signed in |
| `GET /groups` | the groups with their permissions, by name | signed in |
| `GET /members` | the members by name, with `totalPaidCents` (the sum of their payments as `/payments` lists them), `balanceCents`, `overdueCents`, `monthlyFeeCents`, `paidUntil`, `isOverdue`, `version` (`?includeDeleted=1`) | view finances (others: their own) |
| `GET /members/:id` | one member with `payments`, `statusPeriods`, `standingOrders` | view finances, or the member |
| `GET /payments` | payments, newest first (`?member=`, `?from=`, `?to=`) | view finances (others: their own) |
| `POST /payments` | book a payment: `memberId`, `memberVersion`, `amountCents`, `date`, `description`, `receipt`; with `requestId` the booking of a request happens once (see above) | manage finances |
| `PATCH /payments/:id` | change it: `memberVersion` and the fields to change | manage finances |
| `DELETE /payments/:id?memberVersion=` | remove it | manage finances |
| `GET /donations` | donations, newest first (`id`, `amountCents`, `date`, `donorName`, `description`) and the `listVersion` | view finances |
| `POST`, `PATCH /:id`, `DELETE /:id` `/donations` | with `listVersion` (`POST` takes `requestId` as payments do) | manage finances |
| `GET /expenses` | expenses, newest first (`id`, `amountCents`, `date`, `issuer`, `description`, `receipt`) and the `listVersion` | view finances |
| `POST`, `PATCH /:id`, `DELETE /:id` `/expenses` | with `listVersion` (`POST` takes `requestId` as payments do) | manage finances |
| `GET /requests` | requests, newest first: `id`, `type`, `status`, `userId` (who asked), `memberId` (whom it is about; `null` for someone without a member record), `memberName`, `amountCents`, `details`, `createdAt`, `decidedAt`, `rejectionReason` | view finances (others: what they asked and what is about them) |
| `POST /requests` | ask: `type` (`payment`, `expense`, `status`, `standing_order`), `details` (an object), `memberId` (whom it is about: oneself without it; someone else only for those who manage the finances) | signed in |
| `POST /requests/:id/decision` | `status`: `approved` or `rejected` (`rejectionReason`); once - a decided request answers 409. Approving does not book: book the payment or expense with `requestId` first, as the web app does | manage finances |
| `GET /fees` | the monthly fees over time (`feeChanges`: `fromMonth`, `feesCents` per status) and the fresh starts | signed in |
| `GET /finance/summary` | the money as the app's statistics count it, on `today`: `totalsCents` (`memberPayments`, `donations`, `expenses`, `balance`) of what is booked up to today, with what has no readable day (`undatedCents`, from older apps); `months`: per month and kind; `plannedCents` and `planned`: what is dated after today - in no total or balance yet | view finances |
| `GET /finance/changes` | the change log, newest first: `area`, `action`, `at`, `by`, `byName`, `memberId`, `target`, `details` (`before` / `after`) (`?area=`, `?member=`, `?from=`, `?to=` - days of `at`, in UTC) | view finances, admins |
| `GET /events` | the events the person sees, in the order they take place (`?from=`, `?to=`), with `registeredCount`, `waitlistCount`, `myRegistration` | signed in |
| `GET /events/:id` | one event; `duties` and `program` for those who see the duty roster | signed in, if they see it |
| `GET /songs` | the songbook, by title | signed in |
| `GET /mentoring/mentors` | the approved mentors, by name | signed in |
| `GET /mentoring/threads` | the person's conversations, the latest first (the mentee stays anonymous to the mentor) | signed in |
| `GET /mentoring/threads/:id/messages` | the messages, newest first - the next page goes further back (reading marks nothing as read) | the two people of the conversation |

## Example

```bash
TOKEN=$(curl -s -X POST https://agora.example.org/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"kasse@example.org","password":"..."}' | jq -r .token)

# A member and the version of their books
curl -s -H "Authorization: Bearer $TOKEN" 'https://agora.example.org/api/v2/members?limit=500' | jq '.items[0]'

# Book 25.50 for them
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  https://agora.example.org/api/v2/payments \
  -d '{"memberId":"<id>","memberVersion":"<version>","amountCents":2550,"date":"2026-05-05","description":"Beitrag Mai"}'
```
