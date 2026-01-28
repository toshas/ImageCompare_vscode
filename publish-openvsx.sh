#!/bin/bash
set -e

echo "Publishing to Open VSX"
echo "======================"

if [ -z "$TOKEN_OVSX" ]; then
    echo "Error: TOKEN_OVSX environment variable is not set"
    exit 1
fi

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
echo "Version: $VERSION"

# Platform targets: "npm_os npm_cpu vsce_target"
TARGETS=(
    "win32 x64 win32-x64"
    "win32 arm64 win32-arm64"
    "linux x64 linux-x64"
    "linux arm64 linux-arm64"
    "darwin x64 darwin-x64"
    "darwin arm64 darwin-arm64"
)

for entry in "${TARGETS[@]}"; do
    read -r npm_os npm_cpu target <<< "$entry"
    echo ""
    echo "=========================================="
    echo "Publishing for $target..."
    echo "=========================================="

    # Clean and reinstall sharp with correct platform binaries
    echo "Installing sharp for $npm_os/$npm_cpu..."
    rm -rf node_modules/sharp node_modules/@img
    npm install --os=$npm_os --cpu=$npm_cpu --force sharp

    # Publish
    ovsx publish --pat "$TOKEN_OVSX" --target "$target"
done

# Restore native platform binaries
echo ""
echo "Restoring native sharp installation..."
rm -rf node_modules/sharp node_modules/@img
npm install sharp

echo ""
echo "All platforms published successfully!"
