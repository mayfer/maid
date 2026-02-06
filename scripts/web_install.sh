#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mayfer/maid/main/scripts/web_install.sh | bash

REPO="mayfer/maid"
BINARY_NAME="maid"
INSTALL_DIR="$HOME/.local/bin"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}$*${NC}"; }
warn()  { echo -e "${YELLOW}$*${NC}"; }
error() { echo -e "${RED}$*${NC}" >&2; exit 1; }

# Detect OS
OS="$(uname -s)"
case "$OS" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *)      error "Unsupported OS: $OS" ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64|amd64)  arch="x86_64" ;;
    aarch64|arm64) arch="aarch64" ;;
    *)             error "Unsupported architecture: $ARCH" ;;
esac

# Determine asset name pattern: maid-darwin-aarch64, maid-linux-x86_64, etc.
ASSET_NAME="${BINARY_NAME}-${os}-${arch}"

info "Installing ${BINARY_NAME}..."
echo "  OS: ${os}, Arch: ${arch}"

# Get the latest release tag from GitHub API
LATEST_URL="https://api.github.com/repos/${REPO}/releases/latest"
if command -v curl &>/dev/null; then
    RELEASE_JSON="$(curl -fsSL "$LATEST_URL")"
elif command -v wget &>/dev/null; then
    RELEASE_JSON="$(wget -qO- "$LATEST_URL")"
else
    error "Neither curl nor wget found. Please install one and try again."
fi

# Extract download URL for the matching asset
DOWNLOAD_URL="$(echo "$RELEASE_JSON" | grep -o "\"browser_download_url\": *\"[^\"]*${ASSET_NAME}[^\"]*\"" | head -1 | cut -d'"' -f4)"

if [ -z "${DOWNLOAD_URL:-}" ]; then
    TAG="$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -1 | cut -d'"' -f4)"
    echo ""
    error "Could not find asset '${ASSET_NAME}' in release ${TAG:-unknown}.
Available assets:
$(echo "$RELEASE_JSON" | grep '"name"' | grep -v "${REPO}" | cut -d'"' -f4 | sed 's/^/  /')

Make sure a binary for your platform (${os}/${arch}) is attached to the latest GitHub release."
fi

TAG="$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -1 | cut -d'"' -f4)"
warn "→ Downloading ${BINARY_NAME} ${TAG} from GitHub..."

# Download to a temp file
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_FILE="${TMP_DIR}/${BINARY_NAME}"

if command -v curl &>/dev/null; then
    curl -fsSL -o "$TMP_FILE" "$DOWNLOAD_URL"
else
    wget -qO "$TMP_FILE" "$DOWNLOAD_URL"
fi

chmod +x "$TMP_FILE"

# Install
mkdir -p "$INSTALL_DIR"
mv "$TMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}"

# macOS: remove quarantine attribute
if [ "$os" = "darwin" ]; then
    xattr -d com.apple.quarantine "${INSTALL_DIR}/${BINARY_NAME}" 2>/dev/null || true
fi

# Ensure install dir is in PATH
if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
    rc=~/.profile
    [[ "${SHELL:-}" == */zsh ]] && rc=~/.zprofile
    [[ "${SHELL:-}" == */bash && "${OSTYPE:-}" == darwin* ]] && rc=~/.bash_profile
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"
    warn "→ Added ~/.local/bin to PATH in ${rc}"
    warn "  Run: source ${rc}  (or open a new terminal)"
    export PATH="${INSTALL_DIR}:$PATH"
fi

info "✓ ${BINARY_NAME} ${TAG} installed to ${INSTALL_DIR}/${BINARY_NAME}"
echo ""
echo "Run '${BINARY_NAME} --help' to get started."
