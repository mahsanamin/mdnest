# Firebase identity setup (USER_PROVIDER=firebase)

This is the human checklist for turning on federated identity so one Google account works across all your mdnest servers, with 2FA enrolled exactly once.

**When to enable this.** You're running multiple mdnest servers and want one set of credentials to work on all of them. If you're running a single server, `AUTH_MODE=multi` with local passwords is simpler and fine — skip this doc.

**What you keep per server.** Roles (admin vs collaborator), access grants, blocked flag, API tokens. Firebase only handles *who you are*, not *what you can do* on a given server.

---

## Prerequisites

- `AUTH_MODE=multi` is already set and the server has PostgreSQL configured.
- You have a Google account (the one that will administer the Firebase project).
- Your mdnest deployment is reachable over HTTPS (Firebase OAuth requires it for anything except `localhost`).

---

## 1. Create a Firebase project (2 min)

1. Go to <https://console.firebase.google.com> and sign in with the Google account that will own the project.
2. **Add project.** Give it a name (e.g. `mdnest-team`). Disable Google Analytics — not needed.
3. Wait ~30 seconds for the project to provision. Note the **project ID** shown at the top of the overview — you'll need it below (format: `mdnest-team-abc12`).

## 2. Enable Google sign-in (1 min)

1. In the left sidebar: **Build → Authentication → Get started**.
2. Under **Sign-in method**, click **Google**.
3. Toggle **Enable**. Set a "Support email for project" (any email you own).
4. Click **Save**.
5. Still in Authentication: open **Settings → Authorized domains**. Add every domain your mdnest servers are served from (e.g. `notes.example.com`). `localhost` is there by default and is fine for local testing.

## 3. Enable Firestore (1 min)

TOTP 2FA secrets live in Firestore so they're shared across all your mdnest servers.

1. Left sidebar: **Build → Firestore Database → Create database**.
2. Pick **production mode** (locked-down rules). mdnest's backend uses the Admin SDK, which bypasses rules, so strict rules are fine.
3. Pick a location close to your users. You can't change this later.
4. **Security rules** — paste this and click **Publish**:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /{document=**} { allow read, write: if false; }
     }
   }
   ```

   (The Admin SDK running inside mdnest bypasses these rules. Browsers can never read this data directly.)

## 4. Download a service account JSON (1 min)

This is how the mdnest backend proves it's allowed to verify Firebase ID tokens and read/write Firestore.

1. Click the **⚙️ gear icon** top-left → **Project settings**.
2. Tab: **Service accounts**.
3. Click **Generate new private key** → **Generate key**. A JSON file downloads.
4. Save it somewhere permanent and private:

   ```bash
   mkdir -p ~/mdnest
   mv ~/Downloads/<project>-firebase-adminsdk-*.json ~/mdnest/firebase-service-account.json
   chmod 600 ~/mdnest/firebase-service-account.json
   ```

   Treat this file like a password — anyone with it can impersonate your Firebase backend.

## 5. Copy the web SDK config (1 min)

This is the public config the browser needs to initialize the Firebase JS SDK.

1. Still in **Project settings → General** tab.
2. Scroll to **Your apps**. Click the `</>` (Web) icon to register a web app.
3. Name it anything (e.g. `mdnest`). **Don't** tick "Also set up Firebase Hosting". Click **Register app**.
4. Firebase shows a code snippet containing a `firebaseConfig` object like:

   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "mdnest-team.firebaseapp.com",
     projectId: "mdnest-team",
     appId: "1:12345:web:abcdef"
   };
   ```

5. Copy *only those fields* into a file as plain JSON (note the quotes):

   ```json
   {
     "apiKey": "AIzaSy...",
     "authDomain": "mdnest-team.firebaseapp.com",
     "projectId": "mdnest-team",
     "appId": "1:12345:web:abcdef"
   }
   ```

   Save as `~/mdnest/firebase-web-config.json`.

   (This one is not secret — it identifies your Firebase project to the browser. `apiKey` here is a project identifier, not an authentication secret.)

## 6. Wire into `mdnest.conf` (1 min)

Open `mdnest.conf` in your server directory and set (uncommenting if needed):

```bash
AUTH_MODE=multi
USER_PROVIDER=firebase
FIREBASE_PROJECT_ID=mdnest-team
FIREBASE_SERVICE_ACCOUNT=/home/you/mdnest/firebase-service-account.json
FIREBASE_WEB_CONFIG=/home/you/mdnest/firebase-web-config.json
ADMIN_EMAILS=you@example.com
```

`ADMIN_EMAILS` is a comma-separated list. Every email in the list gets `role=admin` in the local database — either on first sign-in or on the next server restart if the row already exists.

## 7. Rebuild and sign in (1 min)

```bash
./mdnest-server rebuild
```

Open your mdnest URL. You'll see **Sign in with Google** instead of the username/password form. Click it → pick your Google account → you're in.

## 8. Invite users

- In the admin panel, invite users by **email** (same flow as local mode).
- When they visit the server and click **Sign in with Google**, their Google email must match the invite. If it does, the pre-created row is claimed and their grants attach.
- Users not in the `users` table and not in `ADMIN_EMAILS` get rejected with "account is not authorized on this server."

## 9. Add more mdnest servers using the same Firebase project

To share identity across another mdnest server:

1. Copy both JSON files (service account + web config) to that server.
2. Set the same `FIREBASE_PROJECT_ID` in that server's `mdnest.conf`.
3. Add the same emails to that server's `ADMIN_EMAILS` / invite them manually.
4. `./mdnest-server rebuild`.

The user signs in with the same Google account, same TOTP code works on both servers.

---

## Things to know

**One-time TOTP re-enroll.** If your server previously had local-mode users with TOTP enabled, those enrollments are stored in Postgres and are NOT migrated to Firestore. On first Firebase sign-in those users will be prompted to re-enroll (one time). We do not dual-read to avoid drift.

**Email matters.** The email on the user's Google account must match the `email` column on their existing `users` row. Audit emails before flipping a server to Firebase mode — mismatches reject with "account is not authorized." Admins can edit an email in the admin UI.

**Admin-reset 2FA is global.** Resetting a user's 2FA via the admin UI deletes the Firestore `totp/{uid}` doc. That user loses 2FA on **every** mdnest server sharing this Firebase project. The admin UI warns before doing it.

**Logout.** Logging out of mdnest clears the mdnest session AND signs you out of Firebase **locally** (forgets the Google sign-in in your browser so the account chooser shows up on next login). It does NOT revoke your Google account globally — you stay signed into Gmail, etc.

**Firebase → local rollback is destructive.** Switching a server from `USER_PROVIDER=firebase` back to local means users have no local password. An admin has to use "Admin reset password" per user before they can log in the classic way. Plan accordingly.

**Clock skew matters for TOTP.** Each server validates codes against its local time. Keep NTP enabled on every mdnest host (default on most distros) so the ±30s TOTP window works across servers.

**Cost.** The TOTP doc is read once per login. Firestore's free tier (50k reads/day, 20k writes/day) is generous for any normal team size. You'll stay on the free **Spark** plan unless you're doing something unusual.

**Where the data lives.**

| Concern | Storage |
|---|---|
| Password | Firebase Auth (none stored in mdnest) |
| Email / display name | Firebase Auth; mirrored in Postgres `users.email` / `users.username` |
| 2FA secret + recovery codes | Firestore `totp/{firebase_uid}` |
| Role (admin/collaborator) | Postgres `users.role` — per-server |
| Namespace grants | Postgres `access_grants` — per-server |
| Blocked flag | Postgres `users.blocked` — per-server |
| API tokens | File-based in `secretsDir` — per-server |

**Troubleshooting.**

- *"Invalid Firebase token"* at login: clock drift on the server, or the web config / service account belong to different projects.
- *"Account is not authorized on this server"*: email not invited on this server. Ask an admin to invite your Google email, or add yourself to `ADMIN_EMAILS` and restart.
- *"auth/unauthorized-domain"* in the browser popup: add your domain to Authentication → Settings → Authorized domains in the Firebase console.
- *Backend fails to start with "failed to init firebase app"*: check the service account JSON file is readable inside the container. The setup script mounts it at `/etc/mdnest/firebase-service-account.json`.
