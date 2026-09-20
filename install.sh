#!/bin/sh
# Install list-tokens from the latest GitHub release.
# Supported platforms: macOS arm64, Linux arm64, Linux x86_64.
#
# Usage:                 ./install.sh
# Custom install dir:    ./install.sh /usr/local/bin
#                       INSTALL_DIR=/usr/local/bin ./install.sh
set -eu

REPO="im-zhong/list-tokens"
INSTALL_DIR="${INSTALL_DIR:-${1:-$HOME/.local/bin}}"

os=$(uname -s)
arch=$(uname -m)
case "$os:$arch" in
  Darwin:arm64) target="darwin-arm64" ;;
  Linux:arm64 | Linux:aarch64) target="linux-arm64" ;;
  Linux:x86_64 | Linux:amd64) target="linux-x64" ;;
  *)
    echo "error: unsupported platform: $os $arch" >&2
    echo "supported: macOS arm64, Linux arm64, Linux x86_64" >&2
    exit 1
    ;;
esac

command -v curl >/dev/null 2>&1 || {
  echo "error: curl is required to download the release" >&2
  exit 1
}

url="https://github.com/$REPO/releases/latest/download/list-tokens-$target"
bin="$INSTALL_DIR/list-tokens"

echo "Installing list-tokens ($target) to $bin"
mkdir -p "$INSTALL_DIR"
curl -fsSL --progress-bar "$url" -o "$bin.tmp"
chmod +x "$bin.tmp"
mv "$bin.tmp" "$bin"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "note: $INSTALL_DIR is not on your PATH; add it with:"
    echo "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc  # or ~/.bashrc"
    ;;
esac

"$bin" --version
echo "Done. Try: list-tokens add <name> <api-key>"
