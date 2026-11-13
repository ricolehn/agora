# API v2

API v2 hands out the data in the shapes of the database structure 4 ([DATABASE.md](DATABASE.md)). The old API (v1,
`/api/...`) stays as it is: every app version keeps working. `GET /api/status` lists the versions a server answers
(`"apiVersions": [1, 2]`).

## Conventions

- **Base:** `/api/v2`. Sign in as for v1 (`POST /api/auth/login`) and send the token: `Authorization: Bearer <token>`.
- **Ids** are the records' ids. **Money** is a whole number of cents (`amountCents: 2550` is 25.50). **Days** are
  `YYYY-MM-DD`, **moments** ISO 8601 in UTC (`2026-05-05T08:30:00.000Z`). Field names are camelCase.
- **Lists** come in pages: `{ "items": [...], "nextCursor": "..." }`. Ask for the next page with `?cursor=<nextCursor>`;
  `nextCursor` is `null` on the last page. `?limit=` sets the page size (default 100, at most 500). A page starts after
  the last item of the page before, so entries added meanwhile shift nothing.
- **Errors:** `{ "error": { "code": "...", "message": "..." } }` with the HTTP status: `invalid` (400), `unauthorized`
  (401), `forbidden` (403), `not_found` (404), `conflict` (409), `server_error` (500).
- **Permissions** are those of v1: the finances need *view finances* to read and *manage finances* to write; a member
  reads their own member record and requests.

## Changes and versions

Every change names the version of the data it is based on. If the data changed meanwhile, the change is refused with
`409 conflict` - read again and repeat the change. Nothing is overwritten unseen.

- A **payment** is part of its member's books: send `memberVersion` (the member's `version`; every payment in an answer
  carries the member's current one).
- **Donations** and **expenses** are lists: send `listVersion` (in the answer of every list read and every change).

Changes made through v2 are the same changes as through the web app: the balances, the statistics and the
[change log](#finance) see them alike.

## Resources

| Method and path | What | Who |
| --- | --- | --- |
| `GET /api/v2` | the resources | signed in |
| `GET /me` | the signed-in person: id, name, e-mail, `isAdmin`, `isOwner`, `permissions`, `groups`, `language`, `timeZone` | signed in |
| `GET /groups` | the groups with their permissions | signed in |
| `GET /members` | the members with `totalPaidCents`, `balanceCents`, `overdueCents`, `monthlyFeeCents`, `paidUntil`, `isOverdue`, `version` (`?includeDeleted=1`) | view finances (others: their own) |
| `GET /members/:id` | one member with `payments`, `statusPeriods`, `standingOrders` | view finances, or the member |
| `GET /payments` | payments, newest first (`?member=`, `?from=`, `?to=`) | view finances (others: their own) |
| `POST /payments` | book a payment: `memberId`, `memberVersion`, `amountCents`, `date`, `description`, `receipt`; with `requestId` the booking of a request happens once, however often it is sent | manage finances |
| `PATCH /payments/:id` | change it: `memberVersion` and the fields to change | manage finances |
| `DELETE /payments/:id?memberVersion=` | remove it | manage finances |
| `GET /donations` | donations (`id`, `amountCents`, `date`, `donorName`, `description`) and the `listVersion` | view finances |
| `POST`, `PATCH /:id`, `DELETE /:id` `/donations` | with `listVersion` | manage finances |
| `GET /expenses` | expenses (`id`, `amountCents`, `date`, `issuer`, `description`, `receipt`) and the `listVersion` | view finances |
| `POST`, `PATCH /:id`, `DELETE /:id` `/expenses` | with `listVersion` | manage finances |
| `GET /requests` | requests (`type`, `status`, `amountCents`, `details`, `createdAt`, `decidedAt`, `rejectionReason`) | view finances (others: their own) |
| `POST /requests` | ask: `type` (`payment`, `expense`, `status`, `standing_order`), `details` | signed in |
| `POST /requests/:id/decision` | `status`: `approved` or `rejected` (`rejectionReason`); once - a decided request answers 409. Approving does not book: book the payment or expense with `requestId` first, as the web app does | manage finances |
| `GET /fees` | the monthly fees over time (`feeChanges`: `fromMonth`, `feesCents` per status) and the fresh starts | signed in |
| `GET /finance/summary` | totals in cents (`memberPayments`, `donations`, `expenses`) and per month and kind | view finances |
| `GET /finance/changes` | the change log: `area`, `action`, `at`, `by`, `byName`, `memberId`, `target`, `details` (`before` / `after`) (`?area=`, `?member=`) | view finances, admins |
| `GET /events` | the events the person sees, in the order they take place (`?from=`, `?to=`), with `registeredCount`, `waitlistCount`, `myRegistration` | signed in |
| `GET /events/:id` | one event; `duties` and `program` for those who see the duty roster | signed in, if they see it |
| `GET /songs` | the songbook | signed in |
| `GET /mentoring/mentors` | the approved mentors | signed in |
| `GET /mentoring/threads` | the person's conversations (the mentee stays anonymous to the mentor) | signed in |
| `GET /mentoring/threads/:id/messages` | the messages (reading marks nothing as read) | the two people of the conversation |

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
