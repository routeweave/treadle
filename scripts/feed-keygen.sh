#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# One-time helper: mint the two signing keypairs the Treadle package feed
# needs, write the PUBLIC keys into the repo (feed/keys/), and print the
# PRIVATE keys for you to paste into GitHub Actions secrets.
#
#   - usign (ed25519) keypair  -> signs the opkg `Packages` index
#                                 secret: OPKG_SIGN_KEY
#   - EC prime256v1 keypair    -> signs the apk v3 `Packages.adb` index
#                                 secret: APK_SIGN_KEY
#
# The private keys are written to ./.feed-keys/ (git-ignored) and echoed
# below; they are never committed. Run this once, add the two repo
# secrets, commit the public keys under feed/keys/, then push a v* tag —
# pages.yml does the rest.
#
# Requirements: usign, openssl, bash. On Debian/Ubuntu usign builds from
# the OpenWrt source (see .github/actions/install-usign); openssl ships
# with the base system.
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v openssl >/dev/null 2>&1 || die "'openssl' not found in PATH"
command -v usign   >/dev/null 2>&1 || die "'usign' not found in PATH (build it from .github/actions/install-usign, or 'opkg install usign' on a router)"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PUB_DIR="$REPO_DIR/feed/keys"
SEC_DIR="$REPO_DIR/.feed-keys"

mkdir -p "$PUB_DIR" "$SEC_DIR"
chmod 700 "$SEC_DIR"

[ -f "$SEC_DIR/treadle-feed.sec" ] && die "$SEC_DIR/treadle-feed.sec already exists — refusing to overwrite an existing key. Remove .feed-keys/ by hand if you really mean to re-mint."

# --- usign (opkg) -----------------------------------------------------------
# usign writes a fingerprint-stamped ed25519 keypair. The .sec file is the
# secret; the .pub file is what routers trust via `opkg-key add`.
usign -G \
	-s "$SEC_DIR/treadle-feed.sec" \
	-p "$PUB_DIR/treadle-feed.pub" \
	-c "Treadle package feed (routeweave/treadle)"

# --- EC prime256v1 (apk v3) -------------------------------------------------
# apk mkndx --sign-key takes the private key; the public half goes in
# /etc/apk/keys/ on the router. Match OpenWrt's own apk build, which signs
# with an EC prime256v1 key (openssl ecparam … prime256v1), so the stock
# 25.12 apk client verifies it. apk v3 matches by key identity, so the
# published filename is cosmetic.
#
# Use `ecparam -genkey` deliberately: it emits the SEC1 form
# (-----BEGIN EC PRIVATE KEY-----), the short encoding with no
# AlgorithmIdentifier. Do NOT switch to `openssl genpkey -algorithm EC` —
# that yields the longer PKCS#8 form (-----BEGIN PRIVATE KEY-----) which
# wraps the key in an id-ecPublicKey/prime256v1 algorithm header.
openssl ecparam -name prime256v1 -genkey -noout -out "$SEC_DIR/treadle-feed.ec" 2>/dev/null
openssl ec -in "$SEC_DIR/treadle-feed.ec" -pubout -out "$PUB_DIR/treadle-feed.pem" 2>/dev/null
chmod 600 "$SEC_DIR/treadle-feed.ec" "$SEC_DIR/treadle-feed.sec"

cat <<EOF

Keys generated.

  Public keys (commit these):
    feed/keys/treadle-feed.pub      (usign / opkg)
    feed/keys/treadle-feed.pem      (EC prime256v1 / apk)

  Private keys (DO NOT commit — kept in .feed-keys/, git-ignored):
    .feed-keys/treadle-feed.sec
    .feed-keys/treadle-feed.ec

Add these two GitHub Actions secrets (Settings -> Secrets and variables ->
Actions). Paste the full file contents verbatim:

  OPKG_SIGN_KEY   <- contents of .feed-keys/treadle-feed.sec
  APK_SIGN_KEY    <- contents of .feed-keys/treadle-feed.ec

Quick copy on Linux:

  gh secret set OPKG_SIGN_KEY < .feed-keys/treadle-feed.sec
  gh secret set APK_SIGN_KEY  < .feed-keys/treadle-feed.ec

Then:  git add feed/keys && git commit -m "feed: add signing public keys"
EOF
