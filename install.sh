#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --repo <path>       Repository to install into (default: current directory)
  --target <path>     Local mirror target (default: /tmp/frontmatter-filter-<repo>)
  --remote <url>      Public remote to publish to
  --branch <name>     Public remote branch (default: main)
  --bin-url <url>     Download URL for frontmatter-filter.mjs when no local dist exists
  --help              Show this help
EOF
}

fail() {
  printf '%s\n' "error: $1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

REPO="$(pwd)"
TARGET=""
REMOTE=""
BRANCH="main"
BIN_URL="${FRONTMATTER_FILTER_BIN_URL-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$#" -ge 2 ] || fail "--repo requires a value"
      REPO="$2"
      shift 2
      ;;
    --target)
      [ "$#" -ge 2 ] || fail "--target requires a value"
      TARGET="$2"
      shift 2
      ;;
    --remote)
      [ "$#" -ge 2 ] || fail "--remote requires a value"
      REMOTE="$2"
      shift 2
      ;;
    --branch)
      [ "$#" -ge 2 ] || fail "--branch requires a value"
      BRANCH="$2"
      shift 2
      ;;
    --bin-url)
      [ "$#" -ge 2 ] || fail "--bin-url requires a value"
      BIN_URL="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

require_command git
require_command node

REPO="$(cd "$REPO" && pwd)"
git -C "$REPO" rev-parse --show-toplevel >/dev/null 2>&1 || fail "Not a git repository: $REPO"

REPO_NAME="$(basename "$REPO")"
if [ -z "$TARGET" ]; then
  TARGET="/tmp/frontmatter-filter-$REPO_NAME"
fi

HOOKS_DIR="$REPO/.githooks"
TOOL_DIR="$HOOKS_DIR/frontmatter-filter"
BIN_PATH="$TOOL_DIR/frontmatter-filter.mjs"
CONFIG_PATH="$TOOL_DIR/.frontmatter-filter.json"
PRE_PUSH_PATH="$HOOKS_DIR/pre-push"
MANAGED_MARKER="managed by frontmatter-filter"

CURRENT_HOOKS_PATH="$(git -C "$REPO" config --local --get core.hooksPath || true)"
if [ -n "$CURRENT_HOOKS_PATH" ] && [ "$CURRENT_HOOKS_PATH" != ".githooks" ]; then
  cat >&2 <<EOF
error: core.hooksPath is already set to '$CURRENT_HOOKS_PATH'
Install manually instead:
  node .githooks/frontmatter-filter/frontmatter-filter.mjs sync "\$@"
EOF
  exit 1
fi

if [ -f "$PRE_PUSH_PATH" ] && ! grep -q "$MANAGED_MARKER" "$PRE_PUSH_PATH"; then
  cat >&2 <<EOF
error: $PRE_PUSH_PATH already exists and is not managed by frontmatter-filter
Install manually instead:
  node .githooks/frontmatter-filter/frontmatter-filter.mjs sync "\$@"
EOF
  exit 1
fi

mkdir -p "$TOOL_DIR"

copy_binary() {
  SCRIPT_DIR=""
  case "$0" in
    */*)
      SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
      ;;
  esac

  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/dist/frontmatter-filter.mjs" ]; then
    cp "$SCRIPT_DIR/dist/frontmatter-filter.mjs" "$BIN_PATH"
  elif [ -n "$BIN_URL" ]; then
    require_command curl
    curl -fsSL "$BIN_URL" -o "$BIN_PATH"
  else
    fail "No local dist/frontmatter-filter.mjs found. Re-run from a built checkout or pass --bin-url."
  fi

  chmod +x "$BIN_PATH"
}

write_pre_push() {
  cat >"$PRE_PUSH_PATH" <<'EOF'
#!/bin/sh
# managed by frontmatter-filter
exec node .githooks/frontmatter-filter/frontmatter-filter.mjs sync "$@"
EOF
  chmod +x "$PRE_PUSH_PATH"
}

run_local_check() {
  if git -C "$REPO" rev-parse --verify HEAD >/dev/null 2>&1; then
    node "$BIN_PATH" check --repo "$REPO" --source-commit HEAD >/dev/null
  else
    printf '%s\n' "warn: repository has no commits yet; skipping local check" >&2
  fi
}

run_remote_preflight() {
  TEMP_DIR="$(mktemp -d /tmp/frontmatter-filter-preflight-XXXXXX)"
  trap 'rm -rf "$TEMP_DIR"' EXIT INT TERM

  git ls-remote "$REMOTE" >/dev/null || return 1

  git -C "$TEMP_DIR" init >/dev/null || return 1
  git -C "$TEMP_DIR" config user.name frontmatter-filter >/dev/null || return 1
  git -C "$TEMP_DIR" config user.email frontmatter-filter@local >/dev/null || return 1
  printf 'preflight\n' >"$TEMP_DIR/README.md"
  git -C "$TEMP_DIR" add README.md >/dev/null || return 1
  git -C "$TEMP_DIR" commit -m preflight --no-gpg-sign >/dev/null || return 1
  git -C "$TEMP_DIR" remote add origin "$REMOTE" >/dev/null || return 1
  git -C "$TEMP_DIR" push --dry-run --force origin "HEAD:$BRANCH" >/dev/null || return 1

  rm -rf "$TEMP_DIR"
  trap - EXIT INT TERM
}

write_config() {
  FRONTMATTER_FILTER_CONFIG_PATH="$CONFIG_PATH" \
  FRONTMATTER_FILTER_TARGET="$TARGET" \
  FRONTMATTER_FILTER_REMOTE="$REMOTE" \
  FRONTMATTER_FILTER_BRANCH="$BRANCH" \
  node <<'EOF'
const fs = require('node:fs');

const configPath = process.env.FRONTMATTER_FILTER_CONFIG_PATH;
const target = process.env.FRONTMATTER_FILTER_TARGET;
const remote = process.env.FRONTMATTER_FILTER_REMOTE;
const branch = process.env.FRONTMATTER_FILTER_BRANCH;

let config = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, 'utf8');
  if (raw.trim().length > 0) {
    config = JSON.parse(raw);
  }
}

config.target = target;
if (remote) {
  config.remote = remote;
  config.branch = branch || 'main';
} else {
  delete config.remote;
  delete config.branch;
}

fs.writeFileSync(`${configPath}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
fs.renameSync(`${configPath}.tmp`, configPath);
EOF
}

copy_binary
write_pre_push
run_local_check

if [ -n "$REMOTE" ]; then
  if ! run_remote_preflight; then
    fail "Remote preflight failed for $REMOTE"
  fi
fi

write_config
git -C "$REPO" config core.hooksPath .githooks

cat <<EOF
Installed frontmatter-filter into $REPO
- runtime: .githooks/frontmatter-filter/frontmatter-filter.mjs
- config: .githooks/frontmatter-filter/.frontmatter-filter.json
- hook: .githooks/pre-push

Next:
1. Review .githooks/frontmatter-filter/.frontmatter-filter.json
2. Commit the .githooks/ files into your repository
EOF
