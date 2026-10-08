<div align="center">
  <img src="assets/icon.png" width="120" alt="Agora Logo" />
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
  --name agora-app \
  --restart unless-stopped \
  ghcr.io/ricolehn/agora:latest
```

*Replace `/path/to/your/storage` and `/path/to/your/cache` with directories on your host machine to ensure your data survives container restarts.*

> **Unraid / Permission Note:** Agora starts as root only long enough to prepare bind-mounted `/app/data`, `/app/db`, and `/app/html` directories for the bundled `node` user (UID 1000), then drops back to `node` before starting the app. If your storage backend blocks ownership changes, make sure every mapped host directory is writable by UID 1000, e.g. `chown -R 1000:1000 /path/to/your/storage /path/to/your/cache /path/to/your/frontend`.

### Optional: Frontend Volume Mapping

The frontend files are bundled directly in `/app/html` inside the container. If you want to customize the frontend (e.g. replace `index.html` or static assets), you can optionally map this path as well:

```bash
docker run -d \
  -p 3000:3000 \
  -v /path/to/your/storage:/app/data \
  -v /path/to/your/cache:/app/db \
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

Browsers receive notifications via Web Push, which works out of the box. The native Android app receives the same notifications (respecting the same per-user notification settings) via Firebase Cloud Messaging. Every instance uses its **own** Firebase project — the app fetches the Firebase client config from your server at runtime, so nothing app-specific has to be rebuilt:

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
  -v /path/to/firebase-adminsdk.json:/run/secrets/firebase.json:ro \
  -e FCM_SERVICE_ACCOUNT_FILE=/run/secrets/firebase.json \
  --name agora-app \
  --restart unless-stopped \
  ghcr.io/ricolehn/agora:latest
```

Both files are read once on startup, so restart the container after adding them. Without them, FCM is disabled (the app then checks for news about every 15 minutes) and everything else (including Web Push) keeps working. Keep the key file private — it is excluded from Git and Docker builds.
</details>

<details>
<summary><b>Privacy, Account Deletion &amp; Reports</b></summary>

## 🔐 Privacy, Account Deletion & Reports

Every instance serves two public pages that app stores (e.g. Google Play) ask for:

- **`/privacy`** – privacy policy describing what Agora stores and which services it uses (push, optional AI provider, e-mail). Review it and add your organisation's contact details if your jurisdiction requires them.
- **`/account-deletion`** – explains what is deleted and lets members delete their account without the app (e-mail + password).

Members can also delete their account in the settings of the web app and the Android app (`POST /api/auth/delete-account`, confirmed with the password). This removes the login, profile picture, registrations, freed duty slots, mentoring profile and conversations, finance requests and push tokens; booked payments stay in the ledger for bookkeeping. The owner account cannot delete itself.

AI replies and mentoring conversations can be reported (`POST /api/reports`); admins get a push notification and can list reports via `GET /api/admin/reports`. Mentoring conversations can be blocked – only the person who blocked can reopen them.
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

## 🧪 Tests

All tests live in `tests/` and use the built-in Node test runner (Node 22+, no extra packages):

| File | Covers |
| --- | --- |
| `platform.test.js` | paths, logo, compression, security headers, proxy, SVG validation, Docker entrypoint |
| `accounts.test.js` | users, groups and permissions (PocketBase layer), account deletion, reports |
| `notifications.test.js` | Web Push, FCM, e-mail, notification settings, duty groups |
| `finance.test.js` | standing orders, request retention, derived finance data |
| `community.test.js` | events, mentoring (capacity, encryption), AI input sanitising |
| `api.test.js` | the real server with PocketBase over HTTP: setup, login, permissions, finances, requests, receipts, events |
| `frontend.test.js` | web app: syntax, translations, inline handlers, referenced files |

```bash
cd backend && npm ci
POCKETBASE_BIN=/path/to/pocketbase npm test   # without POCKETBASE_BIN the HTTP tests in api.test.js are skipped
```

Shared helpers (temporary folders, environment variables) are in `tests/helpers.js`. Every pull request to `develop` runs the suite and a Docker build (`.github/workflows/tests.yml`).

## 📄 License

This project is licensed under the newest GNU General Public License (GPLv3). See the `LICENSE` file for more details.
