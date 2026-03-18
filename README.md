# mdnest

A self-hosted markdown notes app. Plain files on disk, edited in the browser, backed up with git.

**Philosophy:** Your notes are plain `.md` files in a folder. mdnest gives you a clean web UI to read and edit them. Git handles versioning and backup. No database, no vendor lock-in, no proprietary format. You own your data.

## Quick start

```bash
git clone https://github.com/mdnest/mdnest.git
cd mdnest
cp .env.example .env
# Edit .env with your values
docker compose up -d

# To also enable git-sync (auto-commit + push to GitHub):
docker compose --profile sync up -d
```

Open [http://localhost](http://localhost) and log in with the credentials you set in `.env`.

## Set up your notes repository

mdnest expects `NOTES_DIR` to point at a git repository. If you're starting fresh:

```bash
mkdir notes && cd notes
git init
git remote add origin git@github.com:youruser/my-brain.git
echo "# My Brain" > README.md
git add -A && git commit -m "init"
git push -u origin main
```

## GitHub SSH key for git-sync

The `git-sync` sidecar mounts `~/.ssh` read-only so it can push to your remote. Make sure:

1. You have an SSH key that can push to your notes repo (`ssh-keygen -t ed25519` if not).
2. The key is in `~/.ssh/` on the host machine.
3. Your remote repo is added to `~/.ssh/known_hosts` (`ssh-keyscan github.com >> ~/.ssh/known_hosts`).

git-sync will auto-commit and push every 10 minutes.

## Remote access and HTTPS

All ports are bound to `127.0.0.1` by default, so mdnest is only accessible from the host machine. To access it remotely with HTTPS, pick one of:

### Option 1: Tailscale Serve (simplest)

```bash
tailscale serve --bg 80
```

This gives you a `https://your-machine.tailnet-name.ts.net` URL accessible from your Tailscale network. No config changes needed.

### Option 2: Nginx reverse proxy + Certbot

Install nginx and certbot on the host, then proxy to `127.0.0.1:80`:

```nginx
server {
    server_name notes.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:80;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then run `sudo certbot --nginx -d notes.yourdomain.com` for a free TLS certificate.

Update `FRONTEND_ORIGIN` in `.env` to `https://notes.yourdomain.com`.

### Option 3: Cloudflare Tunnel

```bash
cloudflared tunnel create mdnest
cloudflared tunnel route dns mdnest notes.yourdomain.com
cloudflared tunnel --url http://127.0.0.1:80 run mdnest
```

Update `FRONTEND_ORIGIN` in `.env` to `https://notes.yourdomain.com`.

## Environment variables

| Variable | Description | Example |
|---|---|---|
| `MDNEST_USER` | Login username | `ahsan` |
| `MDNEST_PASSWORD` | Login password | `changeme` |
| `MDNEST_JWT_SECRET` | Secret for signing JWT tokens | `changeme` |
| `NOTES_DIR` | Path to notes directory on host | `./notes` |
| `FRONTEND_ORIGIN` | URL where the frontend is served (for CORS) | `http://localhost` |
| `GIT_REMOTE` | SSH URL of the remote notes repo | `git@github.com:youruser/my-brain.git` |
| `GIT_AUTHOR_NAME` | Name for git commits | `Your Name` |
| `GIT_AUTHOR_EMAIL` | Email for git commits | `you@example.com` |

## License

MIT. See [LICENSE](LICENSE).
