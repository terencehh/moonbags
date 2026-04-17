#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${MOONBAGS_REPO_URL:-https://github.com/fciaf420/moonbags.git}"
APP_DIR="${MOONBAGS_DIR:-$HOME/moonbags}"
PM2_NAME="${MOONBAGS_PM2_NAME:-moonbags}"

step() {
  printf "\n\033[1m%s\033[0m\n" "$1"
}

ok() {
  printf "✅ %s\n" "$1"
}

warn() {
  printf "⚠️  %s\n" "$1"
}

fail() {
  printf "❌ %s\n" "$1" >&2
  exit 1
}

detect_os() {
  local os_name
  os_name="$(uname -s 2>/dev/null || printf unknown)"
  case "$os_name" in
    Darwin) printf macos ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        printf wsl
      else
        printf linux
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*) printf windows-shell ;;
    *) printf unknown ;;
  esac
}

ensure_path_line() {
  local shell_rc="$1"
  local line='export PATH="$HOME/.local/bin:$PATH"'
  touch "$shell_rc"
  if ! grep -Fq "$line" "$shell_rc"; then
    printf "\n# MoonBags / OnchainOS\n%s\n" "$line" >> "$shell_rc"
    ok "Added ~/.local/bin to $shell_rc"
  fi
}

step "MoonBags installer"
OS_KIND="$(detect_os)"
case "$OS_KIND" in
  macos) ok "Detected macOS" ;;
  linux) ok "Detected Linux" ;;
  wsl) ok "Detected Windows via WSL" ;;
  windows-shell)
    fail "Detected native Windows shell. Please install/run from WSL2 Ubuntu, then rerun this command there."
    ;;
  *)
    warn "Unknown OS. macOS, Linux, and WSL2 Ubuntu are the tested paths."
    ;;
esac

command -v git >/dev/null 2>&1 || fail "git is missing. Install git, then rerun this installer."
command -v node >/dev/null 2>&1 || fail "Node.js is missing. Install Node 20+, then rerun this installer."
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js 20+ is required. Current version: $(node --version)"
fi
command -v npm >/dev/null 2>&1 || fail "npm is missing. Install Node.js 20+, then rerun this installer."

step "Fetching MoonBags"
if [ -d "$APP_DIR/.git" ]; then
  ok "Repo exists at $APP_DIR"
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

step "Installing dependencies"
npm install

step "Installing OKX OnchainOS"
npm run install:onchainos
export PATH="$HOME/.local/bin:$PATH"

if [ -n "${ZSH_VERSION:-}" ]; then
  ensure_path_line "$HOME/.zshrc"
elif [ -n "${BASH_VERSION:-}" ]; then
  ensure_path_line "$HOME/.bashrc"
else
  [ -f "$HOME/.zshrc" ] && ensure_path_line "$HOME/.zshrc"
  [ -f "$HOME/.bashrc" ] && ensure_path_line "$HOME/.bashrc"
fi

step "Checking setup"
if [ ! -f ".env" ]; then
  warn ".env is missing. Starting setup wizard."
  npm run setup
else
  ok ".env found"
fi

npm run doctor || warn "Doctor found setup issues. Fix the messages above, then run npm run doctor again."

step "PM2"
if ! command -v pm2 >/dev/null 2>&1; then
  warn "pm2 is not installed. Installing pm2 globally."
  npm install -g pm2
fi

if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  PATH="$HOME/.local/bin:$PATH" pm2 start "npm run start" --name "$PM2_NAME" --update-env
fi
pm2 save || warn "pm2 save failed. The bot is running, but may not auto-start after reboot."

step "Done"
ok "MoonBags is installed at $APP_DIR"
ok "Run health checks anytime with: cd $APP_DIR && npm run doctor"
ok "Open the dashboard at: http://localhost:8787"

