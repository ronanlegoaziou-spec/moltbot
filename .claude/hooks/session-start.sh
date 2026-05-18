#!/bin/bash
set -euo pipefail

# Only run in remote Claude Code environment
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install npm dependencies
cd "$CLAUDE_PROJECT_DIR"
npm install

# Configure git push via GitHub token
# Add GITHUB_TOKEN as an environment variable in your Claude Code web session settings
# to enable automatic pushes from remote sessions.
if [ -n "${GITHUB_TOKEN:-}" ]; then
  # Replace the local proxy remote with direct GitHub URL using the token
  git remote set-url origin \
    "https://x-access-token:${GITHUB_TOKEN}@github.com/ronanlegoaziou-spec/moltbot.git"
  echo "[session-start] Git remote configured with GITHUB_TOKEN"
else
  echo "[session-start] GITHUB_TOKEN not set — git push will use read-only proxy (add it in session env vars to enable push)"
fi
