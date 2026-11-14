<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/logo-dark.svg" />
    <img src=".github/assets/logo.svg" width="120" alt="Agora Logo" />
  </picture>
  <h1>Agora</h1>
  <p>
    <a href="LICENSE.md"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg" alt="License: GPLv3" /></a>
    <a href="https://ghcr.io/ricolehn/agora"><img src="https://img.shields.io/badge/GHCR-Ready-brightgreen.svg?logo=docker" alt="GHCR Ready" /></a>
  </p>
</div>

Agora is a web-based financial management application for small groups, clubs, or flatshares. It provides features to track income, expenses, donations, and individual members' contributions. The app consists of a frontend written in HTML/JS, a Node.js backend for handling file uploads, email notifications, and configuration, and an embedded PocketBase instance for authentication and data storage.

## ✨ Features

- **Admin/User Views:** Distinct interfaces tailored for administrators and standard users.
- **Request Management (with approvals):** Users can submit requests (payments, status changes, expenses) which admins can review and approve or reject.
- **Accounts & Person Management:** Nextcloud-inspired user management with role controls (Owner, System Admin, Member) and member statuses (e.g., Vollverdiener, Geringverdiener, etc.).
- **Payments & Standing Orders:** Record recurring and one-time payments efficiently.
- **Fresh start for the fees** *(CALDERA)*: on a day the system admins choose - past or future - every fee account is settled and started afresh: whoever was behind starts from zero, whoever had paid ahead takes exactly that credit along, and from that day on months and payments count anew. Nothing is deleted: payments, the history, the cash balance and "member since" stay as they are. Members who join later simply count from their own start. Set in *Settings → Monthly Fees*, see below.
- **Monthly fees over time** *(CALDERA)*: a change of the fees says from which month it counts - still to come, this month, or reaching back - and the months before keep the old fees. So raising a fee no longer puts everyone who paid month by month behind. Before anything is saved, the admin sees which months cost something else and who owes how much more or less. Every change can be edited, moved to another month or taken back. In *Settings → Monthly Fees*, see below.
- **Donations:** Separate tracking for general donations.
- **Expenses:** Log expenses with optional receipt uploads.
- **Own address for every page:** `/events`, `/events/Jugendfreizeit_2026`, `/settings/profile`, `/songbook/Amazing_Grace`, `/mentoring/chat/<id>` … – links can be shared and bookmarked, a reload stays on the page, and the browser back button walks back step by step. Repeating titles get the date (`/events/Gottesdienst_2026-10-12`); old `#` links keep working.
- **Extras hub:** one place for the additional offers – AI assistant, songbook, prayer requests, media and anonymous polls (tiles appear only for those who may use them).
- **AI assistant (Extras):** answers questions about the community, the finances (with permission) and the events of the coming year – dates, places, registrations, your own duties and, where you may see them, the duty roster and order of service. It only knows what the asking member is allowed to see. Every question gets a compact summary (the newest entries and the totals); when a question needs more – what the Christmas services cost over five years, what was spent on flowers, rent or technology per year, who paid irregularly since 2019, a forecast of the cash balance – it looks up the full history itself (payments, expenses, donations, members with their status history and standing orders, the calendar, the totals per month and year, the finance change log), with the same permissions checked on every lookup. While it works, the line above the reply says what it is doing right now - the lookup in the AI's own words ("Finding Nick among the members"), or the title of its newest thought where the provider shares its thoughts - and afterwards that line opens the steps in order, as in Claude's apps: thoughts, notes on the way, every lookup with what it found. The line stays one line high and calm - it only shows finished titles, each long enough to be read - and the steps open as a window of a few lines ("Show more" opens them in full), so long thoughts never take over the chat; how long the thoughts are is up to the provider (its own summary where it offers one). Categories come from the descriptions; the answer says which descriptions it counted and marks estimates as such. How much it may look up per question is set in *System settings → AI* (**Effort**: low – the summary only; medium – up to 4 small lookups, the default; high, very high (xhigh) and maximum – up to 10, 15 and 20 larger ones and ever deeper thinking where the provider offers it). Providers without tool calls (some local models) keep answering from the summary. See *AI providers* below for the services to choose from.
- **Songbook:** songs with chords (`[G]` inline, `# Chorus` headings, the common ChordPro directives) and key; transposing spells the target key (also German H/B notation), lines wrap on phones, auto-scroll keeps the screen on; font size, chords and transposition are remembered, songs can be printed and shared as a link. The church's CCLI licence number is set in the System configuration and shown with every song. Editing needs the `manage_songbook` permission (existing installations give it to the owner's admin group once).
- **Prayer requests (Extras):** members share a request with their name or anonymously (nobody in the app sees who, not even the leaders) for a week, a month or three months - shown as a calm list, newest first. The owner extends it or removes it when it is done; groups with "Moderate prayer requests" remove unsuitable ones. Back up `data/prayers-secret` with the data folder.
- **Sharing events:** the share icon right of every event's title and organiser (in the Android app too) gives its link to copy or to hand to the system share sheet. Whoever may edit the event (its creator and event managers) decides with a switch whether people **without an account** may open it: they see what, when and where – never the organiser, the participants or the duty roster – and, when the event takes registrations, sign up as guests with full name, e-mail address and age. Guests share the places and the waiting list with members, get a confirmation e-mail (when SMTP is set up) with a link to see or cancel their place, show up as "Guest" in the participant list (e-mail address and age only for the event's editors) and are deleted 30 days after the event. Switched off, the link only works for members again; on again, the old links work again. Shared links show the event's title, date and picture in messenger previews.
- **Duty roster with order of service:** one "+" opens a short dialog with three questions: **What?** (a task, or a song from the songbook found while typing), **Who?** (people and groups picked right in the dialog, any number at once) and **When?** (during the event, or "in the order" - tap the gap where it belongs and pick a duration). Entries in the order get their time from the start of the event and their durations (arrows change the order); the others are tasks during the whole event. People are asked right at an entry (requests, reminders and the apps keep working through the roster); songs open in the band's key.
- **Media (Extras)** *(BA SING SE, in development)*: a folder of the community's Nextcloud becomes a library of pictures and files. Thumbnails come from Nextcloud's previews; pictures open in a full-screen viewer (a preview as large as the screen; pinch, double tap or mouse wheel to zoom, where Nextcloud's largest preview takes over – never the original, so camera formats like DNG, RAW or HEIC show too; swipe or arrow keys for the next one), PDFs open right in the app (the browser's viewer on computers, pdf.js on phones and tablets), videos and music play in the app (formats the browser cannot play are offered as a download). Agora signs in with one Nextcloud account and checks every request itself: members with **Extended media rights** decide per folder what all members get and add other groups or single people where needed: **read**, **write** (upload, new folders, delete) or **no access** (does not see it). The rights hold for them too: they see every folder (to set its rights, also one hidden from them), but its files only where they may read, and add or delete only where they may write. A right applies to all folders below until one sets its own; the most specific right counts (a person's before their groups', a group's before the one for all members); without a right nobody sees anything, and whoever has no access to the base folder does not see Media at all. Right click (or holding a finger on an entry) selects several folders and files: they download together as one ZIP archive and, with write access, can be deleted (in Nextcloud they go to its trash bin; a folder only for whoever may write everywhere in it). Nothing is renamed or overwritten through Agora (a taken name gets a number). Set up in *System settings → Media*, see below.
- **Anonymous polls** *(switched off by default while it is discussed; turn on with `-e AGORA_FEATURE_POLLS=1`, existing polls are kept)*: every member can ask; votes are only counted – nobody in the app (creator or admins) can see who chose what, results appear after the end and only with at least three votes (polls that end with fewer lose their counts for good). Your own choice is remembered on your device only. Back up `data/polls-secret` with the data folder: without it, running polls can no longer tell who already voted.
- **Settings menu:** the settings are a menu of pages (profile, notifications, appearance & language, password, calendar, fees, account) like the apps.

## 🚀 Running the Application

Agora is distributed as an all-in-one Docker image. It includes the frontend, the backend server, and a bundled PocketBase process.

### Quick Start (Docker)

To run Agora, pull the latest image and start a container. Agora keeps general app data and the PocketBase database in separate paths by default:

- `/app/data` for configuration, uploads, and the custom logo
- `/app/db` for the PocketBase database files

That makes it easy to place `/app/db` on faster cache/SSD storage while keeping the rest on larger HDD-backed storage.

```bash
docker pull ghcr.io/ricolehn/agora:latest

docker run -d \
  -p 3000:3000 \
  -v /path/to/your/storage:/app/data \
  -v /path/to/your/cache:/app/db \
  -e TZ=Europe/Berlin \
  --name agora-app \
  --restart unless-stopped \
  ghcr.io/ricolehn/agora:latest
```

*Replace `/path/to/your/storage` and `/path/to/your/cache` with directories on your host machine to ensure your data survives container restarts. Set `TZ` to the time zone of your community: event times are read in it (e.g. for the duty reminders).*

> **Unraid / Permission Note:** Agora starts as root only long enough to prepare bind-mounted `/app/data`, `/app/db`, and `/app/html` directories for the bundled `node` user (UID 1000), then drops back to `node` before starting the app. If your storage backend blocks ownership changes, make sure every mapped host directory is writable by UID 1000, e.g. `chown -R 1000:1000 /path/to/your/storage /path/to/your/cache /path/to/your/frontend`.

### Optional: Frontend Volume Mapping

The frontend files are bundled directly in `/app/html` inside the container. If you want to customize the frontend (e.g. replace `index.html` or static assets), you can optionally map this path as well:

```bash
docker run -d \
  -p 3000:3000 \
  -v /path/to/your/storage:/app/data \
  -v /path/to/your/cache:/app/db \
  -e TZ=Europe/Berlin \
  --v /path/to/your/frontend:/app/html \
  --name agora-app \
  --restart unless-stopped \
  ghcr.io/ricolehn/agora:latest
```

*When mapping `/app/html`, Agora automatically syncs the bundled frontend files from the image into that directory on every start so that image upgrades take effect without removing the volume. Files that were removed in a newer image version are cleaned up automatically.*

> **Custom logo storage:** The admin SVG upload is persisted in `/app/data/church-logo.svg`, not in `/app/html/assets/church-logo.svg`. The app serves `/assets/church-logo.svg` dynamically so the uploaded logo keeps working even when `/app/html` is mapped.

> **Reverse proxy note:** Agora trusts local/private reverse proxies by default so the bundled rate limiting works cleanly behind Docker reverse proxies. If your proxy setup is different, you can override Express' proxy handling with the `TRUST_PROXY` environment variable.

### Updating

Agora is designed to be fully updateable through Docker image upgrades. When you pull a new image and recreate the container, all changes — backend code, frontend files, and the embedded PocketBase binary — are applied automatically. Your data in `/app/data` and `/app/db` is preserved across updates.

```bash
docker pull ghcr.io/ricolehn/agora:latest
docker stop agora-app
docker rm agora-app
docker run -d \
  -p 3000:3000 \
  -v /path/to/your/storage:/app/data \
  -v /path/to/your/cache:/app/db \
  -e TZ=Europe/Berlin \
  --name agora-app \
  --restart unless-stopped \
  ghcr.io/ricolehn/agora:latest
```

**What happens during an update:**

- The new backend code and PocketBase binary are part of the image and take effect immediately.
- The entrypoint script syncs the bundled frontend files into the `/app/html` volume, overwriting outdated files and removing stale ones that no longer exist in the new image.
- The service worker in the browser uses a network-first strategy, so users see the updated frontend as soon as the new container is running.
- All user data (configuration, uploads, database) is stored on the mounted volumes and remains untouched.

### The database upgrade (structure version 4)

Version 4 gives the database a new structure: every booking, member, event, song and setting is a record with real
columns, money in whole cents, real links between tables, and a help text for every field
([docs/DATABASE.md](docs/DATABASE.md)). An existing instance is upgraded by itself at the first start of the new
image. While it runs (seconds; about a minute for 30 years of 300 members), the app shows that it is updating.

1. **Check** – every old record is read and turned into its new records; whatever is odd (an amount typed as
   "50,00", a link to an account deleted long ago) is noted. The check also looks for anything that is not part of
   Agora and depends on a table the upgrade replaces – a collection made on PocketBase's admin page that links to
   one, a view that reads one, an index of your own over a field of `users` that goes: PocketBase would refuse to
   remove that table or field later, so the upgrade waits and names it.
2. **Backup** – a full backup is made first (`pre-v4-<time>.zip` in the `backups` folder of the database). No backup,
   no upgrade. The newest three of these are kept.
3. **Copy** – the new tables are built next to the old ones; nothing old is touched.
4. **Compare** – the new tables must answer every question exactly like the old ones: every member with balance,
   paid until and what is overdue, the statistics, every booking, every event, conversation and setting.
5. **Switch** – one write makes the new tables the database.
6. **Cleanup** – the old tables go (the backup keeps them). From the switch on nothing is ever undone: if the cleanup
   cannot finish (PocketBase did not answer, the server was stopped), everything stays as it is and the cleanup is
   tried again – after a moment by the running server and at every start – until it is through. The app shows that
   the server is starting meanwhile; `/api/status` → `problem` and the server log say why. (The first releases of
   this upgrade removed the new tables when their cleanup failed. A database they left like that is recognised and
   not touched again; the status then asks to restore the `pre-v4-…` backup, after which the upgrade runs anew.)

If anything in steps 1–4 fails or differs, nothing is switched: the new tables are removed and the previous version of
the server (kept in the image, `backend/legacy`) serves the instance exactly as before. The app's status then says
that the upgrade did not get through, and the next start tries again – three times; then it waits until the server is
started with `AGORA_UPGRADE_RETRY=1`. Older apps keep working against the new structure through the old API, which
answers exactly as before.

**Try it first (recommended):** the dry run does the whole upgrade on a copy of a backup – the cleanup included, the
one step nothing can undo – and never touches the original.
Make a backup on PocketBase's admin page (Settings → Backups), then:

```bash
docker exec agora-app node backend/db/dryRun.js /app/db/backups/<backup>.zip --data /app/data --out /app/data
```

It ends with "The upgrade would go through" or names what would differ. `upgrade-dry-run-report.json` contains no
personal data and can be shared when asking for help; `upgrade-dry-run-details.json` contains the values – keep it to
yourself.

**Going back:** stop the container, restore the `pre-v4-…` backup (PocketBase admin page → Settings → Backups, or
unpack it into the database folder) and start the previous image.

**If you ran one of the first releases of version 4:** they kept the password of every account that was created, or
whose password was set, after the upgrade in plain text next to the account (in `users.original`), and so in every
backup made since. The server removes them at its next start and says in its log for how many accounts. Delete the
backups made between the upgrade and that start (the `pre-v4-…` backup is from before and clean); if such a backup
left the server, let these people choose a new password.

<details>
<summary><b>Setup Wizard</b></summary>

## 🛠 Setup Wizard

When you first access the application at `http://localhost:3000` (or your mapped port), you will be greeted by the built-in Setup Wizard. You only need to provide:

1. **App Name:** The name of your instance (e.g., Agora).
2. **Optional SVG Logo:** You can upload a custom logo directly during the wizard.
3. **SMTP Details (Optional):** Credentials for a mail server to send automated status and request notifications.

PocketBase is provisioned automatically inside the container. Agora stores its runtime configuration in `/app/data/config.json`, the uploaded logo in `/app/data/church-logo.svg`, and the PocketBase database in `/app/db` by default. If needed, you can override the database path with `DB_DIR` (or the more explicit `POCKETBASE_DIR`).
</details>

<details>
<summary><b>Android App Push Notifications (Firebase)</b></summary>

## 📱 Android App Push Notifications (Firebase)

The web app receives notifications via Web Push once it is installed (home screen / "Install app"; a plain browser tab never asks and gets none, and iOS only delivers web push to home screen apps anyway), which works out of the box. The native Android app receives the same notifications (respecting the same per-user notification settings) via Firebase Cloud Messaging. Every instance uses its **own** Firebase project — the app fetches the Firebase client config from your server at runtime, so nothing app-specific has to be rebuilt:

1. Create a Firebase project and add an **Android app with the package name `org.agora.app`** (Firebase Console → Project settings → General → Add app).
2. Download its **`google-services.json`** and place it as `/app/data/google-services.json` (or set `FCM_GOOGLE_SERVICES_FILE` / `FCM_GOOGLE_SERVICES_JSON`). It only contains public identifiers.
3. Generate the **service account key** (Project settings → Service accounts → Generate new private key) and provide it in one of these ways:
   - place the file as `/app/data/firebase-service-account.json` in your mapped storage directory, or
   - set `FCM_SERVICE_ACCOUNT_FILE` to the path of the key file inside the container, or
   - set `FCM_SERVICE_ACCOUNT_JSON` to the raw JSON content of the key file.

If you restrict the API key in the Google Cloud console, allow the package `org.agora.app` with the SHA-1 fingerprint of the published app.

```bash
docker run -d \
  -p 3000:3000 \
  -v /path/to/your/storage:/app/data \
  -v /path/to/your/cache:/app/db \
  -e TZ=Europe/Berlin \
  -v /path/to/firebase-adminsdk.json:/run/secrets/firebase.json:ro \
  -e FCM_SERVICE_ACCOUNT_FILE=/run/secrets/firebase.json \
  --name agora-app \
  --restart unless-stopped \
  ghcr.io/ricolehn/agora:latest
```

Both files are read once on startup, so restart the container after adding them. Without them, FCM is disabled (the app then checks for news about every 15 minutes) and everything else (including Web Push) keeps working. Keep the key file private — it is excluded from Git and Docker builds.
</details>

<details>
<summary><b>Media library (Nextcloud)</b></summary>

## 🗂 Media library (Nextcloud)

1. In Nextcloud, create an account for Agora (e.g. `agora-bot`) and a folder for the library in it (e.g. `Agora`). Share existing folders with that account if the pictures live elsewhere. Then, signed in as that account: *Settings → Security → Devices & sessions → Create new app password*.
2. In Agora: *System settings → Media*: the Nextcloud address (with port and path if needed, e.g. `https://cloud.example.org:8443/nextcloud`), the account, the app password and the base folder. *Test connection* lists the folders it finds; switch Media on and save.
3. Give a group the permission **Extended media rights** (new installations: the Admin group has it; existing ones: the owner's admin group gets it once). Its members open *Extras → Media* and set the rights of each folder with the shield (*All folder rights* lists every folder that has some). The rights hold for them too: until a right lets them read (e.g. *read* for all members on the base folder), they see the folders but no files.

The bot account has full rights in Nextcloud; Agora alone decides what members see and do, and only ever reaches the base folder and what is in it. The app password is stored encrypted (key in `data/media-secret` – back it up with the data folder; without it the password has to be entered again) and is never sent to the apps. Files that could run in the browser (HTML, SVG, …) are only ever sent as downloads. Video thumbnails need Nextcloud's ffmpeg preview provider. Pictures and PDFs need Nextcloud's preview generation for thumbnails (PDF thumbnails need its Imagick/Ghostscript provider; without it PDFs show an icon). The PDF viewer for phones (pdf.js 6.3.289, Apache-2.0) is bundled in `assets/vendor/pdfjs/` and served by the instance itself.

API for the apps (all with the member's token; paths relative to the base folder):

| Call | What |
| --- | --- |
| `GET /api/media/status` | `{ enabled, canManage, hasAccess }` – whether to show the tile |
| `GET /api/media/list?path=` | `{ path, access, canManage, folders[], files[] }` – `access` is `read`, `write` or `none` (a folder only passed through) |
| `GET /api/media/preview?path=&size=&crop=1&v=<etag>` | a preview image (sizes 64 … 2048); with `v` it may be cached for good |
| `GET /api/media/file?path=&download=1` | the file (ranges supported) |
| `POST /api/media/upload?path=` | multipart `files` (up to 50, 1 GB each) – needs `write` |
| `POST /api/media/folder` | `{ path, name }` – needs `write` |
| `GET /api/media/rules[?path=]`, `PUT /api/media/rules` | folder rights (`{ path, groups: { <*, groupId or user:<id>>: read\|write\|hide } }`; `GET` lists what can be chosen in `choices`) – extended media rights |
</details>

<details>
<summary><b>Fresh start for the fees (CALDERA)</b></summary>

## 🤖 AI providers

*System settings → AI → Provider* chooses the service the assistant asks:

| Provider | Interface | What it brings |
| --- | --- | --- |
| **Anthropic (Claude)** | Anthropic's Messages API, through Anthropic's official SDK (`@anthropic-ai/sdk`) | Claude's thinking as a readable summary in the chat, effort low to max, the long context cached between the turns of a question (lookups cost far less), and a declined question answered by another Claude model where Anthropic offers that (Claude Opus 5.5 and 5, Sonnet 5.5, Fable 5.2 and 5.1). Recommended model: `claude-opus-5-5` |
| **Google (Gemini)** | the Gemini API | Gemini's thought summaries in the chat. Recommended model: `gemini-2.5-flash` |
| **OpenAI (ChatGPT)** | OpenAI's Responses API | reasoning summaries in the chat (OpenAI may ask for a verified organization), effort up to xhigh; nothing is stored at OpenAI. Recommended model: `gpt-5-mini` |
| **OpenAI-compatible (own address)** | Chat Completions at the address you enter | any other service or local model (Ollama, LM Studio, vLLM, OpenRouter …) – as before there was a choice; installations without a choice keep it |

For the first three only the API key is needed (and a model, if not the recommended one): their address is built in. A server that must reach them through a gateway or proxy can point elsewhere with `AGORA_AI_URL_ANTHROPIC`, `AGORA_AI_URL_GEMINI` or `AGORA_AI_URL_OPENAI`. Switching to another provider asks for its key. A model that does not take a part of the request (tool calls, thinking, an effort level) is noticed once and asked without it from then on – until the settings are saved again; an effort level a model does not know is lowered to the next one it does.

## 🔄 Fresh start for the fees

The fee calculation counts every month since "member since" against every payment a member ever made. A fresh start draws a line on a chosen day:

- **Behind on that day:** the open fees are dropped, the new account starts from zero.
- **Paid ahead on that day:** exactly that credit is carried over into the new account - nothing that was paid is lost.
- **From that day on:** the months from the month of the day on are owed anew and payments from the day on are credited. A payment dated before the day belongs to the time before it: it first makes up for fees that were open then, what goes beyond is credit.
- **No month costs anything else:** what a month costs is said by the fees over time (see below), where every change has the month it counts from. A fresh start, set or taken back, changes the price of none - and fees changed for a month after it never shrink a credit that was carried over.
- **Untouched:** payments, the history, standing orders, the cash balance, reports and "member since". Members who join on the day or later count from their own start as always.

The day may lie in the past (it applies right away) or in the future (it applies when the day comes; until then everything is calculated as before). A later fresh start draws the next line.

Only **system admins** can set one - not treasurers - in *Settings → Monthly Fees*: choose the day, check the numbers (whose open fees are dropped and whose credit is carried over, and how much), then type the day again and enter your password. The numbers are what really changes in the accounts, also next to other fresh starts. A fresh start set by mistake is taken back the same way; nothing was changed in the data, so everything is calculated as before again. Who set or took back which day is kept in a log.

For the apps (all with the member's token):

| Call | What |
| --- | --- |
| `GET /api/fee-reset` | `{ today, resets: [{ date, state }] }` - `state` is `active` (counted from), `scheduled` or `replaced`; with finance or admin rights also `feesBefore` (what the month before it cost when it was set), `setByName`, `setAt` and the `log` |
| `GET /api/admin/fee-reset/preview?date=[&remove=1]` | what setting the day (or with `remove=1`: taking it back) changes: `{ date, inEffect, firstMonth, members, behind, ahead, owesMore, feesBefore, feesWithout, repriced }` - system admins. `behind` and `ahead` are `{ count, total }`: the members who owe less with the fresh start than without it (their open fees that it drops) and those whose credit is carried over on that day. `owesMore` is nobody and `repriced` false: a fresh start changes the price of no month |
| `POST /api/admin/fee-reset`, `POST /api/admin/fee-reset/remove` | `{ date, confirmDate, password }`: sets a fresh start / takes it back - system admins, the day twice and their own password |

Person records carry what the server worked out: `_feeReset` (the day the account counts from, else `null`), `_feeCarriedOver` and `_feeWrittenOff` (the credit taken along / the open fees dropped on that day) and `_monthlyFee` (what this month costs at the member's status). `_paidUntil`, `_overdueAmount` and the other fields describe the account since then.
</details>

<details>
<summary><b>Monthly fees over time (CALDERA)</b></summary>

## 📅 Monthly fees over time

The fees have a history: the fees **from the beginning** and the **changes**, each with the month it counts from. A month costs the fees of the latest change at or before it - so the months before a change keep the old fees, whenever the change is entered.

- **Still to come:** "60 from January" entered in November moves no account until January comes. Until then the apps show the fee of the current month.
- **This month or reaching back:** a change may count from the current month or from one that has passed. It then shows in the accounts at once: whoever paid those months at the old fee owes the difference (or has less credit).
- **Checked first:** before anything is saved, the admin sees which months cost something else, and who owes how much more or less today. What is saved is what was checked - if someone else changed the fees in between, the change is refused and checked again.
- **Edit, move, take back:** every change can get other amounts or another month, or be taken back (from its month on the fees before it count again). The fees from the beginning can be corrected too: they count for every month before the first change.
- **Fresh starts stay what they are:** a change for the time after a fresh start never touches what was dropped or carried over on it. One that reaches back before it works that out again - the admin is told so before saving.

Only **system admins** change the fees - not treasurers - in *Settings → Monthly Fees*; who set or took back what is kept in a log. New fees are offered from next month on, so nobody is behind for a month that has already begun.

**After the update** nothing costs anything else: an instance from before the history gets one that says exactly what was charged until now (one fee for all time, and the fees each fresh start kept for the time before it). **Older apps** keep working: they read the fees of the current month from the fee settings as before, and a fee they save there - they know no month - counts from the current month on.

For the apps (all with the member's token):

| Call | What |
| --- | --- |
| `GET /api/fees` | `{ today, month, current, since, next, entries }` - `current`: the fees of this month (`{ vollverdiener, geringverdiener, keinverdiener, pausiert }`), `since`: the month they count from (`null`: from the beginning), `next`: the change still to come (`{ from, fees }`, else `null`), `entries`: the fees from the beginning (`from: null`) and every change (`from: 'YYYY-MM'`), the earliest first, each with `fees` and `state` (`current`, `planned` or `past`). With finance or admin rights also `setByName`, `setAt`, the `log` and the `version` |
| `POST /api/admin/fees/preview` | `{ from, fees, replaces }` - `from`: the month the fees count from (`null`: from the beginning), `fees`: `{ vollverdiener, geringverdiener, keinverdiener }` as numbers, `replaces`: the month of the change that is edited or moved. Or `{ from, remove: true }` to take the change of that month back. Answers what it does without saving anything: `{ from, remove, movedFrom, stretches, inEffect, members, more, less, freshStart, version }` - `stretches`: the months that cost something else (`{ first, last, before, after }`; `first: null` from the beginning, `last: null` open end), `inEffect`: one of them has come, `more` / `less`: `{ count, total }` of the members who owe more or less today, `freshStart`: the fresh start the change reaches back before (else `null`). System admins |
| `POST /api/admin/fees`, `POST /api/admin/fees/remove` | the same body with the `version` of the preview: saves the change / takes it back. `409` when the fees were changed since (check again) or when nothing would change. System admins |
| `GET /api/db?path=settings` | as before: the fee settings with the fees of the current month. `PUT` with other fees: a change from the current month on (the way of apps without the history) |

Person records carry `_monthlyFee`: what this month costs at the member's status.
</details>

<details>
<summary><b>Privacy, Account Deletion &amp; Reports</b></summary>

## 🔐 Privacy, Account Deletion & Reports

Every instance serves two public pages that app stores (e.g. Google Play) ask for:

- **`/privacy`** – privacy policy describing what Agora stores and which services it uses (push, optional AI provider, optional Nextcloud for media, e-mail). Review it and add your organisation's contact details if your jurisdiction requires them.
- **`/account-deletion`** – explains what is deleted and lets members delete their account without the app (e-mail + password).

Guests of a shared event (signed up without an account) are kept in their own collection that only the server reads. They are deleted when they cancel, when the organisers remove them, with their event, and in any case 30 days after the event (daily cleanup).

The same texts live in this repository for the store listing of the Android app, independent of any instance: [PRIVACY.md](PRIVACY.md) and [ACCOUNT_DELETION.md](ACCOUNT_DELETION.md) (linked from Google Play – keep them in sync with `privacy.html` / `account-deletion.html`).

Members can also delete their account in the settings of the web app and the Android app (`POST /api/auth/delete-account`, confirmed with the password). This removes the login, profile picture, registrations, freed duty slots, mentoring profile and conversations, prayer requests (also anonymous ones), finance requests and push tokens; booked payments stay in the ledger for bookkeeping. The owner account cannot delete itself.

AI replies and mentoring conversations can be reported (`POST /api/reports`); admins get a push notification and can list reports via `GET /api/admin/reports`. Mentoring conversations can be blocked – only the person who blocked can reopen them.

Everyone on a duty (the person who took it, or the members of the assigned group) gets a reminder **3 hours before the event starts** (8:00 on the day for events without a start time), by push and/or e-mail as chosen for duty messages. Event times are read in one time zone for the whole instance: set `TZ` (e.g. `TZ=Europe/Berlin`) for the container; without it (Docker runs in UTC) Agora uses the zone most members' apps report.
</details>

## 👑 Owner & User Roles

The **account created during the initial setup wizard** is designated as the **Owner**:

- `owner: true` (primary instance administrator, protected from deletion/demotion)
- `admin: true` (system administrator with full access)

The Owner and other System Admins can:

- create and manage accounts via the Nextcloud-inspired Accounts tab,
- grant or revoke System-Admin privileges for other users,
- configure payment obligations (`pays: true/false`) and membership dates,
- update `assets/church-logo.svg`,
- configure the application name and SMTP mail settings directly from the system configuration tab.

## 🗄 The database

The map of every table and field: [docs/DATABASE.md](docs/DATABASE.md) (generated from `backend/db/schema/`; the same
texts appear next to each field on PocketBase's admin page).

**Browsing it (port 8090).** PocketBase's admin page runs on port 8090 inside the container. To use it, publish the port
(`-p 8090:8090`) – but only where nobody else can reach it (your own network, a VPN, or `-p 127.0.0.1:8090:8090` and an
SSH tunnel), never on the open internet. Create your own superuser for it:

```bash
docker exec agora-app /app/pocketbase superuser upsert you@example.org 'a-long-password' --dir /app/db
```

Every table is the server's alone: the apps' and members' tokens cannot read them; the server checks every permission.
Reading is safe. Changing records on the admin page bypasses those checks – the server does not expect it; prefer the app.

**Backups.** Back up both folders: `/app/db` (the database; PocketBase can also make backups itself) and `/app/data`. The
data folder holds the configuration and the keys the database alone cannot replace: `.mentoring_key` (the mentoring
conversations are encrypted with it), `polls-secret`, `prayers-secret` and `media-secret`. A database without them is
complete, but encrypted conversations cannot be read, and votes and anonymous prayer requests are no longer recognized
as someone's own.

**The finance change log.** Every change of a booking, member, donation, expense, standing order, status or request is
recorded with who made it and when, with the values before and after (`finance_changes`, written in the same step as
the change itself). It is kept 10 years (the usual bookkeeping period; `AGORA_CHANGE_LOG_YEARS` changes it) and then
removed automatically; the history of the fees and fresh starts is kept for good. When a member is deleted, the log
keeps that their income status changed, not to what.

**For app developers.** [API v2](docs/API_V2.md) (`/api/v2/…`) hands out the data in the new shapes: record ids, money in
whole cents, ISO times, pages with a cursor, and changes that name the version they are based on (409 instead of an
unseen overwrite); finance writes go through the same code as the web app. The old API (`/api/db?path=…`) answers
exactly as before, for every app version. A list saved as
a whole (donations, expenses) can send the version it read (`POST /api/db/transaction` with `currentVersion`, or
`version` with `PUT /api/db`): a list that changed meanwhile is then refused with 409 instead of overwritten.

## 🌍 Languages

English is the source language of the code: every text is written in English, and `assets/locales/en.json` (web app) is always complete. Other languages are optional translations: texts nobody has translated yet are simply left empty (or missing) and show in English. The tests only check English; translations never make them fail.

- **Web app:** users get their system language by default (or pick one in the settings); unsupported languages show English.
- **Server:** error messages are written in English in the code and translated by `backend/locales/<lang>.json` (English text → translation). Push messages and e-mails go out in each member's language: the language their app reported, otherwise the instance's default language (System configuration), otherwise English.

Adding a language (e.g. French):

1. Copy `assets/locales/en.json` to `assets/locales/fr.json`, translate what you can and leave the rest empty (`""`).
2. Optionally create `backend/locales/fr.json` with `"English text": "texte français"` pairs for server texts.
3. Add `'fr'` to `SUPPORTED_LANGUAGES` in `assets/app.js` and `setup.html`, and an option to the language selects in `index.html` (the server picks up new catalogs by itself).

## 🧪 Tests

All tests live in `tests/` and use the built-in Node test runner (Node 24, no extra packages):

| File | Covers |
| --- | --- |
| `platform.test.js` | paths, logo, compression, security headers, proxy, SVG validation, Docker entrypoint |
| `accounts.test.js` | users, groups and permissions (PocketBase layer), account deletion, reports |
| `notifications.test.js` | Web Push, FCM, e-mail, notification settings, duty groups, duty reminders |
| `finance.test.js` | standing orders, request retention, derived finance data, the fresh start of the fee accounts, the monthly fees over time (their rules, and what is stored about them), what the web app books (`assets/finance.js`) |
| `community.test.js` | events, guests and shared places, mentoring (capacity, encryption), AI input sanitising, polls, songbook, prayer requests, order of service |
| `eventContext.test.js` | what the AI learns about events: only what the asking member may see, checked with the real access rules |
| `media.test.js` | media library: folder rights and their inheritance, clean paths, the stored password, Nextcloud's answers, the web app's helpers (`assets/media.js`) |
| `api.test.js` | the real server with PocketBase over HTTP: setup, login, permissions, finances, the fresh start of the fee accounts, the monthly fees over time, requests, receipts, events, sharing and guests, prayer requests, order of service, songbook, media (against a stand-in Nextcloud, `tests/fakeNextcloud.js`), page addresses, API v2, the AI assistant and its lookups against stand-in AI providers (only when the model asks, the effort levels, permissions on every lookup, size caps, categories, providers without tool calls; Anthropic, OpenAI and Gemini through their own protocols, with what they refuse) |
| `ai.test.js` | what the server passes on from the AI provider's stream, and how tool calls arrive in it |
| `frontend.test.js` | web app: syntax, translations, inline handlers, referenced files |
| `codecs.test.js` | the exact round trip between what the apps write and the new tables: 5000 random records per kind, odd values included |
| `database.test.js` | the rules of the database structure (names, help texts, money in cents) and that docs/DATABASE.md is up to date |
| `upgrade*.test.js` | the database upgrade: an instance from before it, filled by the frozen previous backend with years of odd data, answers every read of the old API for every role exactly as before; failures fall back to the previous backend; a twin of the instance that stays on the old backend gets the same changes and answers the same; the dry run; after the switch nothing is undone - a cleanup that fails or is interrupted is tried again until it is through, and what would stop it for good (something of one's own in PocketBase that depends on an old table) is found before anything changes |
| `years.test.js` | the fee accounts over years: two communities lived through day by day for twelve years, with everything that can happen in an order nobody planned (payments early, late and corrected, statuses changed after the fact, fees set for months to come and months past, edited, moved and taken back, fresh starts, an older app saving a fee) - every number the apps show compared with a second set of books that shares no code with the server (`tests/feeBooks.js`). And five years with the real server and PocketBase, which is stopped and wakes up on a later day (`tests/clock.js`) |

```bash
cd backend && npm ci
POCKETBASE_BIN=/path/to/pocketbase npm test   # without POCKETBASE_BIN the HTTP tests (api.test.js, the real server in years.test.js) are skipped
YEARS_SEEDS=1-200 node --test ../tests/years.test.js   # a long look: 200 other communities (a few minutes)
POCKETBASE_BIN=/path/to/pocketbase node ../tests/benchmark.js 300:30   # the books of 300 members over 30 years, before and after the upgrade
```

Shared helpers (temporary folders, environment variables, a frozen clock, starting the real server) are in `tests/helpers.js`. Every pull request to `develop` runs the suite on Node 24, builds the Docker image and audits the dependencies (`.github/workflows/tests.yml`; the audit only warns).

Writing tests that protect without getting in the way:

- **Test contracts, not snapshots.** Assert what must always hold ("the core permissions exist", "a member cannot read this") instead of exact lists, counts or texts that the next feature changes.
- **Security rules belong in `api.test.js`.** One test per rule, written as "X must never work", checked against the real server. Assert the resulting state (the owner is still admin) rather than one specific status code where several would be correct.
- **Known attack patterns are tables.** A new bypass for the SVG filter is one new line in `ATTACKS` (platform.test.js).
- **Every bug fix gets a regression test** that fails without the fix.

## 📄 License

This project is licensed under the newest GNU General Public License (GPLv3). See the `LICENSE` file for more details.
