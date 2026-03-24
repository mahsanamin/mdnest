Review the entire mdnest project for consistency, correctness, and completeness. Report every issue found.

## What to check

### 1. Cross-reference consistency
- Every command in README.md, docs/*.md, setup.sh, mdnest.conf.sample must use the correct script name (`mdnest` for client, `mdnest-server` for server)
- No stale references to old patterns: `docker-compose`, `docker compose --profile sync`, `./setup.sh` in user-facing docs, `./mdnest server`
- API endpoints documented in docs/api.md must match what backend/handlers/ actually implements
- MCP tools listed in README and docs must match what mcp-server/index.js defines
- CLI commands in README must match what the `mdnest` script actually supports

### 2. Code correctness
- backend/: verify Go code compiles (`go build ./...`), check handler method dispatch matches routes in main.go
- frontend/: verify build succeeds (`cd frontend && npx vite build`), check for missing imports or broken refs
- git-sync/sync.sh: check for unquoted variables, unguarded `cd`, missing error handling
- mdnest + mdnest-server: test `--help` output, verify all commands work or fail gracefully

### 3. Feature completeness
- Every API endpoint (GET/POST/PUT/PATCH/DELETE /api/note, etc.) should be documented in docs/api.md with examples
- Every MCP tool should be listed in README
- Every CLI note subcommand should be listed in README
- CLAUDE.md project structure should list all top-level files and directories that exist

### 4. Security
- No credentials or secrets committed (check .gitignore covers .env, mdnest.conf, git-sync/keys/)
- SSH options in sync.sh use `accept-new` not `no` for StrictHostKeyChecking
- CORS middleware allows only the methods the backend actually handles
- Path traversal protection (SafePath) used in all file-handling endpoints

### 5. Docker / deployment
- docker-compose.yml template in setup.sh matches the actual service definitions
- Volumes, ports, environment variables are consistent between setup.sh, mdnest.conf.sample, and docs
- git-sync container mounts are correct (keys dir, sync.sh, namespace volumes)

## Output format

For each issue found, report:
- **File**: path and line number
- **Issue**: what's wrong
- **Fix**: what it should be

If no issues found in a category, say "Clean" and move on. Do not pad the output.
