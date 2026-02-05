#!/usr/bin/env bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

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

SIGN_IDENTITY="${MACOS_SIGN_IDENTITY:--}"
BINARY_PATH="dist/maid"
INSTALL_PATH="$HOME/.local/bin/maid"

# Build the binary
echo -e "${YELLOW}→ Compiling...${NC}"
bun "$SCRIPT_DIR/build.ts"

# Check if binary was created
if [ ! -f "$BINARY_PATH" ]; then
    echo -e "${RED}Error: Binary not found after build${NC}"
    exit 1
fi

# Sign the binary for macOS
echo -e "${YELLOW}→ Signing build artifact with identity: ${SIGN_IDENTITY}${NC}"
if [[ "$SIGN_IDENTITY" == "-" ]]; then
    codesign --force --sign - "$BINARY_PATH"
else
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$BINARY_PATH"
fi
codesign --verify --strict --verbose=2 "$BINARY_PATH"

# Create .local/bin if it doesn't exist
mkdir -p "$HOME/.local/bin"

# Install the binary
echo -e "${YELLOW}→ Installing to ~/.local/bin/maid${NC}"
cp "$BINARY_PATH" "$INSTALL_PATH"
chmod +x "$INSTALL_PATH"

# Re-sign installed binary to ensure signature remains valid at destination.
echo -e "${YELLOW}→ Signing installed binary at ${INSTALL_PATH}${NC}"
if [[ "$SIGN_IDENTITY" == "-" ]]; then
    codesign --force --sign - "$INSTALL_PATH"
else
    codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$INSTALL_PATH"
fi
codesign --verify --strict --verbose=2 "$INSTALL_PATH"
spctl --assess --type execute --verbose=4 "$INSTALL_PATH" || true

# Remove quarantine bit if present.
xattr -d com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true

# Verify installation
if command -v maid &> /dev/null; then
    echo -e "${GREEN}✓ maid installed successfully!${NC}"
    echo ""
    echo "Location: $(which maid)"
    maid --help | head -15
else
    echo -e "${YELLOW}⚠ maid installed but not in PATH${NC}"
    echo "Add ~/.local/bin to your PATH if you haven't already:"
    echo 'export PATH="$HOME/.local/bin:$PATH"'
fi
