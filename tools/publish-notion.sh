#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.example to .env and fill NOTION_TOKEN / NOTION_DATABASE_ID first." >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  echo "Unable to detect current branch" >&2
  exit 1
fi

echo "[1/5] Pull latest from origin/$BRANCH"
git pull --rebase origin "$BRANCH"

echo "[2/5] Sync posts from Notion"
npm run sync:notion

echo "[3/5] Create local commit if posts changed"
git add source/_posts
if git diff --cached --quiet; then
  echo "No post changes detected. Nothing to commit/push."
  exit 0
fi

COMMIT_MSG="${1:-chore: sync notion diary ($(date '+%Y-%m-%d %H:%M:%S'))}"
git commit -m "$COMMIT_MSG"

echo "[4/5] Push commit"
if git push origin "$BRANCH"; then
  echo "Push succeeded."
else
  echo "Push failed once. Rebase and retry..."
  git pull --rebase origin "$BRANCH"
  git push origin "$BRANCH"
fi

echo "[5/5] Done"
echo "GitHub Actions will deploy your site automatically after push."
