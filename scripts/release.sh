#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}$*${NC}"; }
warn()  { echo -e "${YELLOW}$*${NC}"; }
error() { echo -e "${RED}$*${NC}" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

NEW_VERSION_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      NEW_VERSION_ARG="${2:-}"
      if [[ -z "$NEW_VERSION_ARG" ]]; then
        error "--version requires a value (x.y.z)"
      fi
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage:
  ./scripts/release.sh [--version x.y.z]

Options:
  --version x.y.z  Set release version non-interactively
EOF
      exit 0
      ;;
    *)
      error "Unknown argument: $1"
      ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || error "Missing required command: $1"
}

require_clean_git_tree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    error "Git working tree is not clean. Commit or stash changes first."
  fi
}

latest_tag_version() {
  local tag
  tag="$(git tag --list 'v*' --sort=-version:refname | head -1 || true)"
  if [[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]}"
  fi
}

package_version() {
  bun -e 'const p=require("./package.json"); console.log(typeof p.version==="string" ? p.version : "")' 2>/dev/null || true
}

next_patch() {
  local v="$1"
  if [[ "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    local major="${BASH_REMATCH[1]}"
    local minor="${BASH_REMATCH[2]}"
    local patch="${BASH_REMATCH[3]}"
    echo "${major}.${minor}.$((patch + 1))"
    return 0
  fi
  return 1
}

set_package_version() {
  local new_version="$1"
  bun -e '
    const fs=require("fs");
    const path="package.json";
    const pkg=JSON.parse(fs.readFileSync(path,"utf8"));
    pkg.version=process.argv[1];
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  ' "$new_version"
}

build_assets() {
  local release_dir="dist/release"
  mkdir -p "$release_dir"
  rm -f "$release_dir"/maid-*

  local targets=(
    "bun-darwin-arm64:maid-darwin-aarch64"
    "bun-darwin-x64:maid-darwin-x86_64"
    "bun-linux-arm64:maid-linux-aarch64"
    "bun-linux-x64:maid-linux-x86_64"
  )

  for pair in "${targets[@]}"; do
    local target="${pair%%:*}"
    local asset="${pair##*:}"
    warn "→ Building ${target}"
    bun scripts/build.ts --target "$target"
    local built="dist/maid-${target}"
    [[ -f "$built" ]] || error "Expected build artifact not found: $built"
    cp "$built" "${release_dir}/${asset}"
    chmod +x "${release_dir}/${asset}"
  done
}

require_cmd git
require_cmd bun
require_cmd gh
require_clean_git_tree

if ! gh auth status >/dev/null 2>&1; then
  error "GitHub CLI is not authenticated. Run: gh auth login"
fi

CURRENT_PKG_VERSION="$(package_version)"
CURRENT_TAG_VERSION="$(latest_tag_version)"
CURRENT_VERSION="${CURRENT_PKG_VERSION:-$CURRENT_TAG_VERSION}"

if [[ -n "$CURRENT_PKG_VERSION" ]]; then
  info "Current package.json version: ${CURRENT_PKG_VERSION}"
else
  warn "Current package.json version: (not set)"
fi
if [[ -n "$CURRENT_TAG_VERSION" ]]; then
  info "Latest git tag version: ${CURRENT_TAG_VERSION}"
fi

SUGGESTED_VERSION=""
if [[ -n "$CURRENT_VERSION" ]]; then
  SUGGESTED_VERSION="$(next_patch "$CURRENT_VERSION" || true)"
fi

if [[ -n "$NEW_VERSION_ARG" ]]; then
  NEW_VERSION="$NEW_VERSION_ARG"
  info "Using version from --version: ${NEW_VERSION}"
elif [[ -n "$SUGGESTED_VERSION" ]]; then
  read -r -p "Enter new version [${SUGGESTED_VERSION}]: " NEW_VERSION
  NEW_VERSION="${NEW_VERSION:-$SUGGESTED_VERSION}"
else
  read -r -p "Enter new version (x.y.z): " NEW_VERSION
fi

[[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || error "Invalid version '${NEW_VERSION}'. Expected format x.y.z"

TAG="v${NEW_VERSION}"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  error "Tag ${TAG} already exists."
fi

warn "→ Setting package.json version to ${NEW_VERSION}"
set_package_version "$NEW_VERSION"

warn "→ Building release assets"
build_assets

warn "→ Committing version bump"
git add package.json
git commit -m "release: ${TAG}"

warn "→ Creating tag ${TAG}"
git tag "$TAG"

warn "→ Pushing commit and tag"
git push origin HEAD
git push origin "$TAG"

warn "→ Creating GitHub release ${TAG}"
gh release create "$TAG" dist/release/* --title "$TAG" --generate-notes

info "✓ Release complete: ${TAG}"
