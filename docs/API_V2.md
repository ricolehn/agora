# API v2

API v2 hands out the data in the shapes of the database structure 4 ([DATABASE.md](DATABASE.md)) and does everything
the apps do: the books, the requests, the fees and fresh starts, the calendar with its duty roster, mentoring, the
songbook, prayer requests and the media library. The old API (v1, `/api/...`) stays as it is: every app version keeps
working. `GET /api/status` lists the versions a server answers (`"apiVersions": [1, 2]`).

What stays with v1 because it is no data of the community: signing in and out, registering, the password and deleting
one's own account (`/api/auth/...`), push registration (`/api/push/...`), the live updates (`/api/stream`), the AI
assistant (`/api/ai/chat`), the anonymous polls (switched off while they are discussed) and the administration of the
instance (`/api/admin/...`).

## Stability

API v2 is stable: what it answers keeps its name, its type and its meaning, and what it takes stays taken. It only
grows - new resources, new fields in answers, new optional fields in a request, new values of a fixed choice (a new
`area` of the change log, a new kind of request, a new error code). So a client ignores fields it does not know and
takes a value of a choice it does not know as "other". Whatever would break a client comes as a new version next to
v2 (`/api/v3`), never as a change of v2.

## Conventions

- **Base:** `/api/v2`. Sign in as for v1 (`POST /api/auth/login`) and send the token: `Authorization: Bearer <token>`.
- **Ids** are the records' ids. **Money** is a whole number of cents (`amountCents: 2550` is 25.50). **Days** are
  `YYYY-MM-DD`, **months** `YYYY-MM`, **times of day** `HH:mm`, **moments** ISO 8601 in UTC
  (`2026-05-05T08:30:00.000Z`). Field names are camelCase.
- **Lists** come in pages, every one of them: `{ "items": [...], "nextCursor": "..." }`. Ask for the next page with
  `?cursor=<nextCursor>`; `nextCursor` is `null` on the last page. `?limit=` sets the page size (default 100, at most
  500 - more counts as 500). A page starts after the last item of the page before, so entries added meanwhile shift
  nothing. Every list has a fixed order (see the resources); "by name" and "by title" ignore case and accents
  ("Ärger" comes next to "Arger").
- **Search:** where a list takes `?q=`, every word of it must be found - case and accents aside - in the item's texts
  (names, descriptions, titles), its day (`2026-05-05`, `05.05.2026` or `5.5.2026`) or its amount (`25.50`, `25,50`).
- **What a request sends** is JSON, and every value is checked: what does not fit is refused with `invalid` (400) -
  never cut or guessed. Money: a whole number of cents, at most 100,000,000,000 either way (negative for a
  correction). A day: a day of the calendar (`2026-02-31` is refused - in a body as in `?from=` and `?to=`). Texts:
  `description` and `note` at most 5,000 characters (as long as a request's note may be: what is asked is booked as it
  is), `rejectionReason` 500, `donorName` and `issuer` 200; other texts as the resource says. An id: a record id. A
  `limit`, `cursor` or `q` that is none is refused, too. Fields a resource does not know are ignored.
- **Receipts** are files in the receipts folder: upload one with `POST /receipts`, then name it. An entry answers
  `receipts` (the names, a list) and `receipt` (the field as the web app keeps it: one name, or several as a JSON list
  `'["a.png","b.pdf"]'`). A write takes `receipts` (a list, at most 20 names; `[]` takes them away) or `receipt` (one
  name; `null` or `""` takes it away) - not both.
- **Errors:** `{ "error": { "code": "...", "message": "...", "field": "..." } }` with the HTTP status - every error,
  also those of the sign-in, the limits and a server that is starting: `invalid` (400, also a body that is no JSON),
  `unauthorized` (401), `forbidden` (403), `not_found` (404), `conflict` (409), `too_large` (413), `rate_limited`
  (429), `server_error` (500), `unavailable` (503: the server is starting or updating its database - ask again after
  the seconds in `Retry-After` -, or Media is not set up). The `code` is what a client acts on.
  `message` is for people, in the language of the request: the one the app asks for (`Accept-Language`), else the
  person's own (as the app reported it), else the instance's default - English where no translation exists. `field`
  (only with `invalid`, where one value did not fit) names that value as the request named it (`date`,
  `details.note`, `items.2.minutes`).
- **Permissions** are those of v1: the finances need *view finances* to read and *manage finances* to write - system
  admins and the owner too, who see the finances only through the permissions of their groups; a member
  reads their own member record, payments, standing orders and requests (and sees a record nobody's account is linked
  to that bears their full name, to link it to their account). The fees and fresh starts are changed by
  system admins; the calendar, mentoring, the songbook and media follow their own rights as in the apps.

## Changes and versions

Every change of the books names the version of the data it is based on. If the data changed meanwhile, the change is
refused with `409 conflict` - read again and repeat the change. Nothing is overwritten unseen.

- **Payments, standing orders and status changes** are part of their member's books: send `memberVersion` (the
  member's `version`; every payment and standing order in an answer carries the member's current one as
  `memberVersion`).
- **Donations** and **expenses** are lists: send `listVersion` (in the answer of every list read and every change).
  Each entry keeps its record (and its `id`) whatever else changes in the list.
- **Booked for a request** (`requestId` with a payment, a donation, an expense or a standing order): the request is
  booked once, however often it is sent. Sent again - after an answer that got lost, say - it answers `200` with the
  booking that is there (a new booking answers `201`). With another member, amount or day it is no repetition and
  refused (`409`). The booking's `clientId` is `req_<requestId>`.
- **A request decided and booked in one step:** `POST /requests/:id/decision` with `{ "status": "approved", "book":
  true }` books what the request asks for the way the web app does - the payment, the expense (the requester is the
  issuer, the receipts go with it), the standing order (its months up to today booked at once) or the status change
  from its day - once, and decides. A booking a client made first with `requestId` is found, not made again. Decided
  by someone else meanwhile (`409`): when that was a rejection, what this call booked is taken back; an approval keeps
  its booking. *Booking first and deciding afterwards* (`requestId`, then the decision without `book`) still works;
  a client doing so reads the request when the decision answers `409`: approved by someone else, the booking is theirs
  and stays - only after a rejection is it to be taken back.
- An entry an older app wrote without an id of its own gets one (`clientId`) with its first change through v2. A
  payment then gets a new record id - take the `id` of the answer; donations, expenses and standing orders keep theirs.

Changes made through v2 are the same changes as through the web app: the balances, the statistics, the
[change log](#the-books) and the notifications see them alike.

## Resources

### Who is signed in

| Method and path | What | Who |
| --- | --- | --- |
| `GET /api/v2` | the resources | signed in |
| `GET /me` | the signed-in person: id, name, e-mail, `isAdmin`, `isOwner`, `permissions`, `groups`, `language`, `timeZone`, `notificationSettings` (`channels`: `push`, `email`; `push` and `email`: for each kind of message - `duties`, `events`, `messages`, `requests`, `finances`, `reports` - whether it comes that way), and `can` (`viewFinances`, `manageFinances`, `manageEvents`, `manageMentoring`, `manageSongbook`, `useAi`, `manageRegistrationCode` - what the app may offer; the server checks every call itself) | signed in |
| `PATCH /me` | what is the person's own to choose: `notificationSettings` (what it does not name stays as it is), `timeZone` (an IANA name such as `Europe/Berlin`: duty reminders come in it), `language` (`de`, `en`). Answers as `GET /me` | signed in |
| `PUT /me/picture` | the own profile picture (multipart, field `picture`: a JPEG, at most 5 MB). Answers `{ userId, version }` | signed in |
| `GET /pictures` | who has a profile picture, by account id: `userId`, `version` (it changes with the picture) | signed in |
| `GET /pictures/:id` | the picture of an account (JPEG; `204`: it has none) - with `?v=<version>` it may be kept for good | signed in |
| `GET /groups` | the groups with their permissions, by name | signed in |
| `GET /people` | the people a duty can go to, by name (`?q=`): `id`, `name`, `groups`, `email` (only for those who organise events) | signed in |
| `GET /registration-code`, `POST /registration-code` | the code people register with (`{ code }`) / a new one, made by the server (the one before stops working) | *manage registration code* |
| `POST /reports` | reports an AI reply (`type: ai`, `content`, `prompt`) or a message of a mentoring conversation (`type: chat`, `content`, `threadId`) to the admins - with a `reason` (500); `content` and `prompt` at most 4,000 characters. Answers `204` | signed in |

### The books

| Method and path | What | Who |
| --- | --- | --- |
| `GET /members` | the members by name (`?q=`, `?includeDeleted=1`), with `totalPaidCents` (the sum of their payments as `/payments` lists them), `balanceCents`, `overdueCents`, `monthlyFeeCents`, `paidUntil`, `isOverdue`, `version` - and the fee account as the apps show it: `currentStatus` (the status this month is charged at), `feeState` (`overdue`, `standingOrder`: paid by a running standing order, `ok`), `isDueSoon` (a standing order still books this month), `hasActiveStandingOrder`, `anticipatedCents` (what it books), `freshStart` (`{ day, carriedOverCents, writtenOffCents }`: the fresh start the account counts from, else `null`) | view finances (others: their own) |
| `GET /members/:id` | one member with `payments`, `statusPeriods`, `standingOrders` | view finances, or the member |
| `PUT /members/:id/account` | links an account to the member record: `userId`. A member links their own account to a record that no account is linked to and bears their full name (`/members` lists it to them, with `userId: null`, as v1 does) | manage finances; the member for their own account |
| `GET /accounts` | the accounts by name (`?q=`, `?unlinked=1`: those without a member record): `id`, `name`, `email`, `memberId` | admins |
| `GET /payments` | payments, newest first (`?member=`, `?from=`, `?to=`, `?q=`): `id`, `memberId`, `amountCents`, `date`, `description`, `receipt`, `receipts`, `source` (`manual`, `standingOrder`, `request`), `standingOrderId`, `clientId`, `memberVersion` | view finances (others: their own) |
| `POST /payments` | book a payment: `memberId`, `memberVersion`, `amountCents`, `date`, `description`, `receipts`; with `requestId` the booking of a request happens once (see above) | manage finances |
| `PATCH /payments/:id` | change it: `memberVersion` and the fields to change | manage finances |
| `DELETE /payments/:id?memberVersion=` | remove it | manage finances |
| `GET /standing-orders` | standing orders, the latest start first (`?member=`): `id`, `memberId`, `amountCents`, `startDate`, `endDate`, `note`, `lastBookedOn`, `clientId`, `memberVersion` | view finances (others: their own) |
| `POST /standing-orders` | a standing order: `memberId`, `memberVersion`, `amountCents`, `startDate`, `note`, `endDate` (not before today), `requestId`. What it owes from its start up to today is booked at once, as the web app and the server's daily run book it | manage finances |
| `PATCH /standing-orders/:id` | change it: `memberVersion` and `amountCents`, `startDate`, `note`, `endDate` (`null` takes it away). An end takes back the payments it booked after its last day; once that day has passed, the daily run removes the standing order (its payments stay) | manage finances |
| `DELETE /standing-orders/:id?memberVersion=` | remove it; the payments it booked stay | manage finances |
| `POST /status-changes` | a member's income status from a day on, as the web app changes it: `memberId`, `memberVersion`, `status` (`vollverdiener`, `geringverdiener`, `keinverdiener`, `pausiert`), `date` (not before the membership). Answers the member as `/members/:id` | manage finances |
| `GET /donations` | donations, newest first (`?from=`, `?to=`, `?q=`): `id`, `amountCents`, `date`, `donorName`, `description`, `clientId` - and the `listVersion` | view finances |
| `POST`, `PATCH /:id`, `DELETE /:id` `/donations` | with `listVersion` (`POST` takes `requestId` as payments do) | manage finances |
| `GET /expenses` | expenses, newest first (`?from=`, `?to=`, `?q=`): `id`, `amountCents`, `date`, `issuer`, `description`, `receipt`, `receipts`, `clientId` - and the `listVersion` | view finances |
| `POST`, `PATCH /:id`, `DELETE /:id` `/expenses` | with `listVersion` (`POST` takes `requestId` as payments do) | manage finances |
| `GET /finance/ledger` | every booking in one list - the history of the books - newest first (`?q=`, `?kind=` `memberPayment`, `donation` or `expense`, `?member=`, `?from=`, `?to=`): `kind`, `id`, `amountCents`, `date`, `who` (the member, donor or issuer), `memberId`, `description`, `receipts`, `clientId`, `source` | view finances |
| `POST /receipts` | upload a receipt (multipart, field `receipt`): a picture (JPG, PNG, WebP, GIF, HEIC, HEIF) or a PDF, at most 50 MB. Answers `201 { name }` - name it with an entry or a request | signed in |
| `GET /receipts/:name` | the file | view or manage finances - and whoever uploaded it |
| `GET /finance/summary` | the money as the app's statistics count it, on `today`: `totalsCents` (`memberPayments`, `donations`, `expenses`, `balance`) of what is booked up to today, with what has no readable day (`undatedCents`, from older apps); `months`: per month and kind; `plannedCents` and `planned`: what is dated after today - in no total or balance yet | view finances |
| `GET /finance/changes` | the change log, newest first: `area`, `action`, `at`, `by`, `byName`, `memberId`, `target`, `details` (`before` / `after`; `{ "removed": true }` once what it was about is deleted - a request, or a member's status, standing order or own values: the log keeps that it changed, by whom and when, not to what) (`?area=`, `?member=`, `?from=`, `?to=` - days of `at`, in UTC) | view finances |

### Requests

| Method and path | What | Who |
| --- | --- | --- |
| `GET /requests` | requests, newest first (`?status=` `pending`, `approved` or `rejected`, `?q=`): `id`, `type`, `status`, `userId` (who asked), `memberId` (whom it is about; `null` for someone without a member record), `memberName`, `amountCents`, `details`, `receipts`, `createdAt`, `decidedAt`, `rejectionReason` (`null`: none given) | view finances (others: what they asked and what is about them) |
| `POST /requests` | ask: `type` (`payment`, `expense`, `status`, `standing_order`), `details` (an object: `amount`, `date`, `note`, `description`, `receipt`, `newStatus` as the kind needs - texts at most 5,000 characters), `memberId` (whom it is about: oneself without it; someone else only for those who manage the finances), `notify` (`true`: the treasurers are told by push and e-mail, as the web app asks for it) | signed in |
| `POST /requests/:id/decision` | `status`: `approved` or `rejected` (`rejectionReason`); once - a decided request answers 409. `book: true` with an approval books what the request asks for in the same step (see above) | manage finances |

### The fees and fresh starts

| Method and path | What | Who |
| --- | --- | --- |
| `GET /fees` | the monthly fees over time: `today`, `month`, `currentCents` (this month's fee per status), `since` (the month they count from), `next` (`{ fromMonth, feesCents }`, a change still to come), `feeChanges` (the fees from the beginning first - `fromMonth` empty -, also before a change was ever saved; then every change: `fromMonth`, `feesCents`, `state`: `current`, `planned` or `past`), `freshStarts`. Who set what (`setAt`, `setByName`), the `version` and the `log` for those who see the finances and admins (`setByName` is empty for everyone else) | signed in |
| `POST /fees/preview` | what a change would do before anything is saved: `fromMonth` (`null`: the fees from the beginning), `feesCents` (`vollverdiener`, `geringverdiener`, `keinverdiener`), `replaces` (the month of the change that is edited or moved) - or `{ fromMonth, remove: true }`. Answers `stretches` (the months that cost something else: `first`, `last`, `beforeCents`, `afterCents`), `inEffect`, `members`, `more` and `less` (`{ count, totalCents }`: who owes more or less today), `freshStart`, `version` | system admins |
| `POST /fees` | saves the change as it was checked: the same body and the `version` of the preview (`409`: the fees were changed since - check again). Answers the fees as `GET /fees` | system admins |
| `POST /fees/remove` | takes a change back: `{ fromMonth, version }` | system admins |
| `GET /fresh-starts` | the fresh starts of all fee accounts: `today`, `items` (`day`, `state`: `active`, `scheduled` or `replaced`); for those who see the finances and admins also `feesBeforeCents`, `setAt`, `setByName` of each, and the `log` | signed in |
| `GET /fresh-starts/preview?day=` | what a fresh start on that day changes (`&remove=1`: taking it back): `inEffect`, `firstMonth`, `members`, `behind` and `ahead` (`{ count, totalCents }`: whose open fees it drops, whose credit it carries over), `owesMore`, `feesBeforeCents`, `feesWithoutCents`, `repriced` | system admins |
| `POST /fresh-starts`, `POST /fresh-starts/remove` | `{ day, confirmDay, password }`: sets a fresh start / takes it back - the day twice and the admin's own password | system admins |

### The calendar

| Method and path | What | Who |
| --- | --- | --- |
| `GET /events` | the events the person sees, in the order they take place (`?from=`, `?to=`, `?q=`), with `registeredCount`, `waitlistCount`, `minimumReached`, `isFull` (every place taken: a sign-up goes onto the waiting list), `myRegistration`, `createdByName`, `canEdit`, `shareToken` (while the event is shared: the link `/?share=<shareToken>` shows it to people without an account) and `duties` - the duty roster for those who see it (`null` for everyone else): `id`, `section`, `roleName`, `status` (`open`, `requested`, `declined`, `assigned`, `confirmed`), `notes`, `assignedGroupId`, `assignedUserId`, `requestedUserId`, `requestedById`, each with its name (`assignedGroupName`, `assignedUserName`, `requestedUserName`, `requestedByName`) | signed in |
| `GET /events/:id` | one event, as the list has it; the `program` (the order of service: `items`, `updatedAt`) for those who see the duty roster | signed in, if they see it |
| `POST /events` | an event: `title`, `date`, `endDate`, `startTime`, `endTime`, `location`, `description`, `requiresRegistration`, `minParticipants`, `maxParticipants` (0: no limit; the minimum no higher than the places), `targetGroups` (names or ids; empty: everyone), `imageUrl` (from `POST /events/images`). `duties` (at most 50 it starts with - every date of a series gets them: `roleName`, `section`, `notes`, `assignedGroupId`). Those who manage events also `kind` (`event`, `termin`), `isPinned` and `recurrence` (`{ rule: weekly, biweekly or monthly, count: 2 to 52 }`). Answers the first date with `seriesCount`; the target groups are told | signed in |
| `PATCH /events/:id` | change it - also `status` (`scheduled`, `cancelled`) and `isPublic` (shared with people without an account). More places move the waiting list up. `kind` and `isPinned` are changed by those who manage events; its creator may send them as they are | its creator, those who manage events |
| `DELETE /events/:id` | delete it with its order of service | its creator, those who manage events |
| `PUT /events/:id/registration` | sign up: a place, or the waiting list when it is fully booked (`myRegistration` of the answer says which) | who sees the event |
| `DELETE /events/:id/registration` | cancel; the first one waiting moves up | who signed up |
| `GET /events/:id/participants` | who comes and who waits, in the order they signed up: `userId` (members), `guestId` and `isGuest` (people without an account), `name`, `status`, `signedUpAt`; `email` and `age` of guests for those who may edit the event | who sees the event |
| `DELETE /events/:id/participants/:who` | remove a member (`:who` their account id) or a guest (`guest:<guestId>`, who gets an e-mail) | its creator, those who manage events |
| `PUT /events/:id/program` | the order of service: `items` (at most 60: `title` or `songId` with `songKey`, `minutes` 0-600, `who`, `note`) | who may edit the event |
| `POST /events/images` | a picture (multipart, field `image`, at most 25 MB): answers `201 { name, url }` | signed in |
| `GET /events/:id/calendar.ics` | the event as a calendar file | who sees the event |
| `POST /events/:id/duties` | a duty: `roleName`, `section`, `notes`, and `assignedGroupId` (a group has it) or `requestedUserId` (asked of a person, by push and e-mail - `sendEmail: false`: no e-mail) | who may edit the event |
| `PATCH /duties/:id` | change it: `roleName`, `section`, `notes`, `assignedGroupId`, `assignedUserId`, `status: open` (frees it); the person who has it changes the `notes` only | who may edit the event, the person who has it |
| `DELETE /duties/:id` | delete it | who may edit the event |
| `POST /duties/:id/request`, `DELETE /duties/:id/request` | ask a person (`userId`, `sendEmail`) / withdraw the request | who may edit the event (and who asked) |
| `POST /duties/:id/assignment` | give it to a group (`groupId`) or ask a person (`userId`) | who may edit the event |
| `POST /duties/:id/answer` | `answer`: `accept` or `decline` - whoever asked is told | the person asked |
| `PUT /duties/:id/claim`, `DELETE /duties/:id/claim` | take an open duty (or one asked of oneself) / give it back | who sees the event / the person who has it |
| `GET /duty-requests` | the duties the person was asked to do and has not answered yet, the soonest first | signed in |
| `GET /calendar-feed`, `POST /calendar-feed/reset` | the address of the person's own calendar for calendar apps (`feedUrl`, `webcalUrl`) / a new one (the one before stops working) | signed in |

### Community

| Method and path | What | Who |
| --- | --- | --- |
| `GET /songs` | the songbook, by title (`?q=`: title, writer, words), with the church's `ccliLicense` (shown with every song) | signed in |
| `GET /songs/:id` | one song, with the `ccliLicense` | signed in |
| `POST /songs`, `PATCH /songs/:id`, `DELETE /songs/:id` | a song: `title` (120), `content` (20,000; ChordPro), `artist`, `key`, `capo` (0-11), `tempo` (20-300), `ccli`, `copyright`. A change takes only the fields it sends | *manage songbook* |
| `GET /prayers` | the running prayer requests, newest first - and the person's own that ran out (to extend them): `text`, `isAnonymous`, `authorUserId` and `authorName` (`null` when shared anonymously: nobody sees who, not even the leaders), `createdAt`, `expiresAt`, `isExpired`, `isMine`, `canDelete` - and `canModerate` | signed in |
| `POST /prayers` | share one: `text` (3 to 1,000 characters), `duration` (`week`, `month` or `quarter`), `anonymous` | signed in |
| `PATCH /prayers/:id` | extend it: `extend` (`week`, `month` or `quarter`) | who shared it |
| `DELETE /prayers/:id` | remove it | who shared it, *moderate prayer requests* |
| `GET /mentoring/mentors` | the approved mentors, by name: `userId`, `name`, `bio`, `maxMentees`, `isAccepting`, `activeMentees`, `isFull`. Those who manage mentoring: `?status=` `pending`, `rejected` or `all`, and their e-mail addresses | signed in |
| `GET /mentoring/profile`, `PATCH /mentoring/profile` | the person's own profile as a mentor (`null`: never applied) / change it: `bio`, `maxMentees`, `isAccepting` | signed in |
| `POST /mentoring/application` | apply as a mentor (`bio`, `maxMentees`); applying again asks anew | signed in |
| `POST /mentoring/mentors/:id/status` | `status`: `approved`, `rejected` or `pending` | manage mentoring |
| `GET /mentoring/threads` | the person's conversations, the latest first: `role`, `title` (the mentor's name; the mentee's alias for the mentor - the mentee stays anonymous), `status`, `isClosed`, `isBlocked`, `isBlockedByMe`, `unreadCount`, `lastMessage`, `lastMessageAt` | signed in |
| `POST /mentoring/threads` | ask a mentor (`mentorUserId`, `message`) - they are told | signed in |
| `GET /mentoring/threads/:id/messages` | the messages, newest first - the next page goes further back (reading marks nothing as read) | the two people of the conversation |
| `POST /mentoring/threads/:id/messages` | send one (`text`, at most 10,000 characters) - the other one is told | the two people of the conversation |
| `POST /mentoring/threads/:id/read` | what the other one wrote is read | the two people of the conversation |
| `PATCH /mentoring/threads/:id` | `status`: `active`, `closed` or `blocked` (only who blocked it opens it again) | the two people of the conversation |

### Media

Paths are relative to the base folder of the library (README, *Media library*); the rights are checked on every call.

| Method and path | What | Who |
| --- | --- | --- |
| `GET /media` | `{ enabled, canManage, hasAccess }` - whether to show Media | signed in |
| `GET /media/items?path=` | what a folder holds: `folder` (`path`, `name`, `access`: `read`, `write` or `none` for a folder only passed through, `canManage`) and its `items` - its folders, then its files, each by name (`isFolder`, `kind`, `name`, `path`, `size`, `modified`, `contentType`, `etag`) | who may see the folder |
| `GET /media/preview?path=&size=&crop=1&v=` | a preview picture (sizes 64 to 2048; with `v` - the file's `etag` - it may be cached for good) | who may read the file |
| `GET /media/file?path=&download=1` | the file (ranges too) | who may read the file |
| `POST /media/files?path=` | upload (multipart, field `files`, up to 50 of 1 GB each): nothing is replaced, a taken name gets a number | write access |
| `POST /media/folders` | a folder: `{ path, name }` | write access |
| `POST /media/delete` | `{ path, names }`: entries of one folder go to Nextcloud's trash bin (a folder only for whoever may write everywhere in it): `{ deleted, failed }` | write access |
| `POST /media/downloads` | `{ path, names }`: entries of one folder as one ZIP archive - answers `{ id, url, files }`; the `url` gives it, for a while, to whoever asked | who may see the folder |
| `GET /media/rules`, `PUT /media/rules` | the rights of the folders (`?path=` adds that folder's) / set those of one folder: `{ path, groups: { <*, a group id or user:<id>>: read, write or hide } }` | extended media rights |

## Example

```bash
TOKEN=$(curl -s -X POST https://agora.example.org/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"kasse@example.org","password":"..."}' | jq -r .token)

# A member and the version of their books
curl -s -H "Authorization: Bearer $TOKEN" 'https://agora.example.org/api/v2/members?limit=500&q=anna' | jq '.items[0]'

# Book 25.50 for them
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  https://agora.example.org/api/v2/payments \
  -d '{"memberId":"<id>","memberVersion":"<version>","amountCents":2550,"date":"2026-05-05","description":"Beitrag Mai"}'

# Approve a request and book it in one step - the error, if any, in German
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -H 'Accept-Language: de' \
  https://agora.example.org/api/v2/requests/<id>/decision -d '{"status":"approved","book":true}'
```
