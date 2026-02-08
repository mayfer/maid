#!/usr/bin/env bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

BUILD_ALL=false
for arg in "$@"; do
    case "$arg" in
        --all) BUILD_ALL=true ;;
    esac
done

echo -e "${GREEN}Building maid CLI binary...${NC}"

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_repo_root() {
    local d="$SCRIPT_DIR"
    for _ in {1..12}; do
        if [[ -f "$d/package.json" && ( -f "$d/bun.lock" || -f "$d/bun.lockb" ) ]]; then
            echo "$d"
            return 0
        fi
        local p
        p="$(dirname "$d")"
        [[ "$p" == "$d" ]] && break
        d="$p"
    done
    return 1
}

REPO_ROOT="$(find_repo_root || true)"
if [[ "${REPO_ROOT:-}" == "" ]]; then
    echo -e "${RED}Could not find repo root (package.json + bun.lock) from $SCRIPT_DIR${NC}" >&2
    exit 1
fi

cd "$REPO_ROOT"

DEFAULT_SIGN_IDENTITY="Developer ID Application: Murat Ayfer (2463KXRFPH)"
SIGN_IDENTITY="${MACOS_SIGN_IDENTITY:-$DEFAULT_SIGN_IDENTITY}"
BINARY_PATH="dist/maid"
INSTALL_PATH="$HOME/.local/bin/maid"

if [[ -z "${MACOS_SIGN_IDENTITY:-}" ]]; then
    echo -e "${YELLOW}⚠ Using default signing identity: ${DEFAULT_SIGN_IDENTITY}${NC}"
    echo -e "${YELLOW}  Set MACOS_SIGN_IDENTITY to override (example: MACOS_SIGN_IDENTITY='-' ./scripts/install.sh)${NC}"
fi

# Build the native binary (installed locally)
echo -e "${YELLOW}→ Compiling (native)...${NC}"
bun "$SCRIPT_DIR/build.ts"

# Check if binary was created
if [ ! -f "$BINARY_PATH" ]; then
    echo -e "${RED}Error: Binary not found after build${NC}"
    exit 1
fi

# Cross-compile all targets when --all is passed
if [[ "$BUILD_ALL" == true ]]; then
    for target in bun-darwin-x64 bun-darwin-arm64 bun-linux-x64 bun-linux-arm64; do
        echo -e "${YELLOW}→ Cross-compiling for ${target}...${NC}"
        bun "$SCRIPT_DIR/build.ts" --target "$target"
    done
    # Rename to expected convention: maid-{os}-{arch}
    mv dist/maid-bun-darwin-arm64 dist/maid-darwin-aarch64
    mv dist/maid-bun-darwin-x64   dist/maid-darwin-x86_64
    mv dist/maid-bun-linux-arm64  dist/maid-linux-aarch64
    mv dist/maid-bun-linux-x64    dist/maid-linux-x86_64
    echo -e "${GREEN}✓ Cross-platform binaries built in dist/${NC}"
fi

# Sign the binary for macOS
if [[ "$(uname -s)" == "Darwin" ]]; then
    echo -e "${YELLOW}→ Signing build artifact with identity: ${SIGN_IDENTITY}${NC}"
    if [[ "$SIGN_IDENTITY" == "-" ]]; then
        codesign --force --sign - "$BINARY_PATH"
    else
        codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$BINARY_PATH"
    fi
    codesign --verify --strict --verbose=2 "$BINARY_PATH"
fi

# Create .local/bin if it doesn't exist
mkdir -p "$HOME/.local/bin"

# Install the binary
echo -e "${YELLOW}→ Installing to ~/.local/bin/maid${NC}"
cp "$BINARY_PATH" "$INSTALL_PATH"
chmod +x "$INSTALL_PATH"

# Sign and verify installed binary on macOS
if [[ "$(uname -s)" == "Darwin" ]]; then
    echo -e "${YELLOW}→ Signing installed binary at ${INSTALL_PATH}${NC}"
    if [[ "$SIGN_IDENTITY" == "-" ]]; then
        codesign --force --sign - "$INSTALL_PATH"
    else
        codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$INSTALL_PATH"
    fi
    codesign --verify --strict --verbose=2 "$INSTALL_PATH"
    spctl --assess --type execute --verbose=4 "$INSTALL_PATH" || true
    xattr -d com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true
fi

# Ensure ~/.local/bin is in PATH
[[ ":$PATH:" != *":$HOME/.local/bin:"* ]] && { rc=~/.profile; [[ $SHELL == */zsh ]] && rc=~/.zprofile; [[ $SHELL == */bash && $OSTYPE == darwin* ]] && rc=~/.bash_profile; echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc" && echo -e "${YELLOW}→ Added ~/.local/bin to PATH in $rc${NC}"; export PATH="$HOME/.local/bin:$PATH"; } || echo -e "${GREEN}✓ ~/.local/bin already in PATH${NC}"

# Verify installation
if command -v maid &> /dev/null; then
    echo -e "${GREEN}✓ maid installed successfully!${NC}"
    echo ""
    echo "Location: $(which maid)"
    maid --help | head -15
else
    echo -e "${RED}Error: maid not found after installation${NC}"
    exit 1
fi
