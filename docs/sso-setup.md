# Corporate SSO setup (USER_PROVIDER=sso)

This is the operator checklist for letting users sign in to mdnest with your corporate identity provider (Google Workspace, Okta, Microsoft Entra, Keycloak, Auth0 — anything that implements OIDC discovery).

**When to use this.** You have an IdP your team already signs in with, you want one set of credentials + central MFA, and you don't want to manage local passwords inside mdnest. If you're running a personal install on a laptop, skip — the built-in username/password is simpler.

**What mdnest controls vs what the IdP controls.**

| Concern | Owner |
|---|---|
| Who you are (identity) | **IdP** — mdnest trusts the ID token |
| MFA / 2FA | **IdP** — mdnest never prompts for TOTP in SSO mode |
| Who can sign in here (authorization) | **mdnest** — email must match an invited user row |
| Role (admin / collaborator) | **mdnest** — `users.role` column, per server |
| Namespace grants | **mdnest** — `access_grants`, per server |

So: the IdP tells us *who*, mdnest decides *what they can do on this server*.

---

## Prerequisites

- `AUTH_MODE=multi` is already set and Postgres is wired up. SSO doesn't work in single-user mode.
- Your mdnest deployment is reachable over HTTPS (most IdPs reject plain-HTTP redirect URIs outside localhost).
- You can create an OAuth 2.0 client with your IdP's admin console. You'll need two things from it: **client ID** and **client secret**.

## 1. Register an OAuth client with your IdP (2 min)

You need an **OAuth 2.0 / OIDC web application client** with one authorized redirect URI:

```
https://<your-mdnest-host>/api/auth/sso/callback
```

Below are quick steps per provider. Your DevOps team likely does this already for other tools.

**Google Workspace / Google OIDC** ([console](https://console.cloud.google.com)):
1. Project → **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Authorized redirect URIs: `https://<your-mdnest-host>/api/auth/sso/callback`.
4. Copy the **Client ID** and **Client secret**.

**Okta**:
1. Admin console → **Applications → Create App Integration → OIDC / Web Application**.
2. Sign-in redirect URIs: `https://<your-mdnest-host>/api/auth/sso/callback`.
3. Controlled access: restrict to the groups that should see mdnest.
4. Copy **Client ID** and **Client secret**, note the org's OIDC issuer URL.

**Microsoft Entra ID** (Azure AD):
1. **App registrations → New registration**, name `mdnest`.
2. Redirect URI type: **Web**, value as above.
3. **Certificates & secrets → New client secret** — copy the value (not the secret ID).
4. **Expose an API** isn't needed; we're a relying party, not an API.
5. Copy **Application (client) ID** and the tenant's issuer (`https://login.microsoftonline.com/<tenant-id>/v2.0`).

**Keycloak / Auth0 / Custom**:
Any provider with OIDC discovery works. You need the **issuer URL** (the thing that serves `/.well-known/openid-configuration`), plus a client ID and secret for a confidential web client.

## 2. Wire into `mdnest.conf` (1 min)

```bash
AUTH_MODE=multi
USER_PROVIDER=sso

SSO_ISSUER_URL=https://accounts.google.com    # swap for your IdP
SSO_CLIENT_ID=<from-step-1>
SSO_CLIENT_SECRET=<from-step-1>

# Optional: restrict to corporate email domains (comma-separated).
SSO_ALLOWED_DOMAINS=wego.com

# Optional: override the button label (default: "SSO").
SSO_PROVIDER_LABEL=Google

# Optional: only set if your callback URL isn't FRONTEND_ORIGIN/api/auth/sso/callback.
# SSO_REDIRECT_URL=https://notes.example.com/api/auth/sso/callback
```

Any email in `ADMIN_EMAILS` (if set) is still auto-promoted to admin role on startup — same behaviour as the Firebase path.

## 3. Make sure users exist (1 min)

**Unlike Firebase mode, SSO does NOT auto-create users on first sign-in.** Only emails that already exist in the `users` table can log in — the IdP says "this is ahsan@wego.com", and mdnest looks that up; if there's no match, you get redirected back with `sso_not_invited` in the URL hash.

So before the first user signs in:

- Invite them through the admin UI (or `/api/admin/invite` directly). The *email* field must match the email the IdP will send.
- Users can be created with an arbitrary password — it won't be used. You can use any placeholder, since local login will be disabled client-side in SSO mode.
- If you're migrating an existing deployment with local passwords, nothing moves automatically — the `users` rows stay, their `password_hash` goes unused, and users sign in via SSO going forward.

## 4. Rebuild and sign in (1 min)

```bash
./mdnest-server rebuild
```

Open the mdnest URL. You'll see a **Sign in with \<label\>** button instead of the username/password form. Click it → pick your corporate account at the IdP → you land back in mdnest, logged in.

## 5. Add more mdnest servers (if you want)

Each server is configured independently. Pointing two mdnest servers at the *same* OAuth client works — but the safer pattern is one client per server, since redirect URIs are per-client.

---

## Things to know

**Only 2FA at the IdP.** `REQUIRE_2FA` in `mdnest.conf` is ignored with a log notice when `USER_PROVIDER=sso`. The TOTP handlers aren't registered at all in this mode — your IdP enforces MFA, and we don't mirror it locally. If you later flip back to `local`, users will need to re-enroll TOTP.

**Profile name + picture come from the IdP.** Every successful SSO login mirrors the `name` and `picture` claims from the OIDC ID token into the local `users` row (`username` filled in once when empty, `avatar_url` refreshed on each login since picture URLs rotate). The sidebar renders the picture as an `<img>` with a graceful fallback to initials if the image fails to load. New users created via the SQL-INSERT bootstrap path automatically pick up their real face + name on first sign-in. Admin-set usernames are never overwritten — the backfill only fills empty slots.

**Switching back to `local` is destructive.** If you go `sso` → `local`, existing rows have no password (or a stale one) and you'll need to `AdminResetPassword` each user.

**Email is matched case-insensitively** on the backend, but the allowlist comparison also lowercases, so `User@Wego.com` and `user@wego.com` both hit the same row and both pass the domain check for `wego.com`.

**Open-redirect safety.** The `from=` query param on `/api/auth/sso/start` is sanitized to a plain absolute path on our origin — full URLs, protocol-relative URLs, and query strings are stripped. The JWT never leaves the top-level fragment (`#sso_token=…`), which never gets sent as a Referer to third parties.

**Cookies.** State / nonce / PKCE verifier live in a single HMAC-signed cookie `mdnest_sso_state`. Short-lived (10 minutes), `HttpOnly`, `SameSite=Lax`, `Secure` when `FRONTEND_ORIGIN` is HTTPS. No server-side session store.

**Logout.** "Logout" in mdnest clears the mdnest JWT. It does NOT call the IdP's end-session endpoint — your corporate Google/Okta session stays valid for other apps. If users want to fully sign out of the IdP too, they do it in the IdP's own UI.

**Cost.** Zero extra infrastructure. No Firestore, no cloud dependency, no extra process. The Go backend talks to the IdP directly.

**Troubleshooting (redirect hash codes).**

| Code | Meaning | Fix |
|---|---|---|
| `sso_denied:<reason>` | IdP rejected the sign-in (user cancelled, scope not approved, etc.) | Read the reason; usually retry. |
| `sso_not_invited` | IdP authenticated the user but their email has no mdnest row | Invite them via the admin UI. |
| `sso_blocked` | Their mdnest account is blocked | Unblock in the admin UI. |
| `sso_failed` | Generic validation error — state cookie expired, code exchange failed, ID token invalid | Check backend logs; most common cause is clock skew (keep NTP on) or a redirect URI typo. |
| `sso_internal` | Backend hit an error minting the JWT or looking the user up | Check backend logs. |
