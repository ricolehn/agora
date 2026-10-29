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
- **Donations:** Separate tracking for general donations.
- **Expenses:** Log expenses with optional receipt uploads.
- **Own address for every page:** `/events`, `/events/Jugendfreizeit_2026`, `/settings/profile`, `/songbook/Amazing_Grace`, `/mentoring/chat/<id>` … – links can be shared and bookmarked, a reload stays on the page, and the browser back button walks back step by step. Repeating titles get the date (`/events/Gottesdienst_2026-10-12`); old `#` links keep working.
- **Extras hub:** one place for the additional offers – AI assistant, songbook, prayer requests, media and anonymous polls (tiles appear only for those who may use them).
- **AI assistant (Extras):** answers questions about the community, the finances (with permission) and the events of the coming year – dates, places, registrations, your own duties and, where you may see them, the duty roster and order of service. It only knows what the asking member is allowed to see.
- **Songbook:** songs with chords (`[G]` inline, `# Chorus` headings, the common ChordPro directives) and key; transposing spells the target key (also German H/B notation), lines wrap on phones, auto-scroll keeps the screen on; font size, chords and transposition are remembered, songs can be printed and shared as a link. The church's CCLI licence number is set in the System configuration and shown with every song. Editing needs the `manage_songbook` permission (existing installations give it to the owner's admin group once).
- **Prayer requests (Extras):** members share a request with their name or anonymously (nobody in the app sees who, not even the leaders) for a week, a month or three months - shown as a calm list, newest first. The owner extends it or removes it when it is done; groups with "Moderate prayer requests" remove unsuitable ones. Back up `data/prayers-secret` with the data folder.
- **Sharing events:** the share icon right of every event's title and organiser (in the Android app too) gives its link to copy or to hand to the system share sheet. Whoever may edit the event (its creator and event managers) decides with a switch whether people **without an account** may open it: they see what, when and where – never the organiser, the participants or the duty roster – and, when the event takes registrations, sign up as guests with full name, e-mail address and age. Guests share the places and the waiting list with members, get a confirmation e-mail (when SMTP is set up) with a link to see or cancel their place, show up as "Guest" in the participant list (e-mail address and age only for the event's editors) and are deleted 30 days after the event. Switched off, the link only works for members again; on again, the old links work again. Shared links show the event's title, date and picture in messenger previews.
- **Duty roster with order of service:** one "+" opens a short dialog with three questions: **What?** (a task, or a song from the songbook found while typing), **Who?** (people and groups picked right in the dialog, any number at once) and **When?** (during the event, or "in the order" - tap the gap where it belongs and pick a duration). Entries in the order get their time from the start of the event and their durations (arrows change the order); the others are tasks during the whole event. People are asked right at an entry (requests, reminders and the apps keep working through the roster); songs open in the band's key.
- **Media (Extras)** *(BA SING SE, in development)*: a folder of the community's Nextcloud becomes a library of pictures and files. Thumbnails come from Nextcloud's previews; pictures open in a full-screen viewer (a preview as large as the screen; pinch, double tap or mouse wheel to zoom, where Nextcloud's largest preview takes over – never the original, so camera formats like DNG, RAW or HEIC show too; swipe or arrow keys for the next one), PDFs open right in the app (the browser's viewer on computers, pdf.js on phones and tablets), videos and music play in the app (formats the browser cannot play are offered as a download). Agora signs in with one Nextcloud account and checks every request itself: members with **Extended media rights** decide per folder what all members get and add other groups or single people where needed: **read**, **write** (upload, new folders) or **no access** (does not see it). A right applies to all folders below until one sets its own; the most specific right counts (a person's before their groups', a group's before the one for all members); without a right nobody sees anything, and whoever has no access to the base folder does not see Media at all. Nothing can be deleted, renamed or overwritten through Agora (a taken name gets a number). Set up in *System settings → Media*, see below.
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
3. Give a group the permission **Extended media rights** (new installations: the Admin group has it; existing ones: the owner's admin group gets it once). Its members open *Extras → Media* and set the rights of each folder with the shield (*All folder rights* lists every folder that has some).

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

<details>
<summary><b>PocketBase access model</b></summary>

## 🔐 PocketBase access model

Agora provisions PocketBase automatically and configures the collections, indexes, and default records on startup:

- **Admins** can read and write all people, requests, donations, expenses, settings, and user records.
- **Regular users** can authenticate with PocketBase, read/update their own profile, read shared settings, read the public invite code, view only their linked person/request records, and submit their own requests.
- **The Owner** and **System Admins** can manage user roles and system-wide configuration.
</details>

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
| `finance.test.js` | standing orders, request retention, derived finance data, what the web app books (`assets/finance.js`) |
| `community.test.js` | events, guests and shared places, mentoring (capacity, encryption), AI input sanitising, polls, songbook, prayer requests, order of service |
| `eventContext.test.js` | what the AI learns about events: only what the asking member may see, checked with the real access rules |
| `media.test.js` | media library: folder rights and their inheritance, clean paths, the stored password, Nextcloud's answers, the web app's helpers (`assets/media.js`) |
| `api.test.js` | the real server with PocketBase over HTTP: setup, login, permissions, finances, requests, receipts, events, sharing and guests, prayer requests, order of service, songbook, media (against a stand-in Nextcloud, `tests/fakeNextcloud.js`), page addresses |
| `frontend.test.js` | web app: syntax, translations, inline handlers, referenced files |

```bash
cd backend && npm ci
POCKETBASE_BIN=/path/to/pocketbase npm test   # without POCKETBASE_BIN the HTTP tests in api.test.js are skipped
```

Shared helpers (temporary folders, environment variables, a frozen clock) are in `tests/helpers.js`. Every pull request to `develop` runs the suite on Node 24, builds the Docker image and audits the dependencies (`.github/workflows/tests.yml`; the audit only warns).

Writing tests that protect without getting in the way:

- **Test contracts, not snapshots.** Assert what must always hold ("the core permissions exist", "a member cannot read this") instead of exact lists, counts or texts that the next feature changes.
- **Security rules belong in `api.test.js`.** One test per rule, written as "X must never work", checked against the real server. Assert the resulting state (the owner is still admin) rather than one specific status code where several would be correct.
- **Known attack patterns are tables.** A new bypass for the SVG filter is one new line in `ATTACKS` (platform.test.js).
- **Every bug fix gets a regression test** that fails without the fix.

## 📄 License

This project is licensed under the newest GNU General Public License (GPLv3). See the `LICENSE` file for more details.
