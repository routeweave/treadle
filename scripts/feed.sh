#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Assembles the Treadle package feed — an OpenWrt-style repository a router
# can add and then `update` / `install` / `upgrade` from. Output tree:
#
#   $FEED_OUT/
#     index.html               landing page with install instructions
#     keys/treadle-feed.pub     usign public key (opkg trusts via opkg-key)
#     keys/treadle-feed.pem     EC public key (apk trusts in /etc/apk/keys)
#     apk/                      *.apk + signed Packages.adb (apk v3 / 25.12+)
#     opkg/                     *.ipk + Packages(.gz) + Packages.sig (24.10)
#
# The feed serves EVERY v* release (not just the newest) so old versions
# stay installable and apk/opkg can resolve upgrades. The package is
# `noarch`/`all`, so one index per format covers every architecture — no
# per-arch subdirectories.
#
# Inputs (env):
#   FEED_OUT          output dir                       (default ./public)
#   APK_SIGN_KEY_FILE  path to the apk signing key (EC prime256v1)   (required)
#   OPKG_SIGN_KEY_FILE path to the opkg signing key (usign private)  (required)
#   FEED_SRC_DIR      pre-populated dir of *.apk/*.ipk; skips the gh
#                     download (for local testing)              (optional)
#   PAGES_URL         absolute feed URL baked into index.html
#                     (default https://routeweave.github.io/treadle)
#
# Requirements: apk (apk-tools 3.x, for mkndx), usign, gzip, tar,
# sha256sum, awk, find; gh (only when FEED_SRC_DIR is unset).
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found in PATH"; }

for cmd in apk usign gzip tar sha256sum awk find; do require_cmd "$cmd"; done

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FEED_OUT="${FEED_OUT:-$REPO_DIR/public}"
PAGES_URL="${PAGES_URL:-https://routeweave.github.io/treadle}"
KEYS_SRC="$REPO_DIR/feed/keys"

[ -n "${APK_SIGN_KEY_FILE:-}" ] && [ -f "$APK_SIGN_KEY_FILE" ] || die "APK_SIGN_KEY_FILE not set or missing"
[ -n "${OPKG_SIGN_KEY_FILE:-}" ] && [ -f "$OPKG_SIGN_KEY_FILE" ] || die "OPKG_SIGN_KEY_FILE not set or missing"
[ -f "$KEYS_SRC/treadle-feed.pub" ]     || die "missing $KEYS_SRC/treadle-feed.pub — run feed-keygen.sh and commit feed/keys/"
[ -f "$KEYS_SRC/treadle-feed.pem" ] || die "missing $KEYS_SRC/treadle-feed.pem — run feed-keygen.sh and commit feed/keys/"

APK_DIR="$FEED_OUT/apk"
OPKG_DIR="$FEED_OUT/opkg"
rm -rf "$FEED_OUT"
mkdir -p "$APK_DIR" "$OPKG_DIR" "$FEED_OUT/keys"

# ---------------------------------------------------------------------------
# Gather every v* release's packages.
#
# The feed is rebuilt from scratch on every run, so a release whose assets
# fail to download would silently vanish from the index — possibly the
# newest one. Any download failure aborts the build instead; the previous
# deployment stays live until a clean run replaces it.

DL_DIR="$(mktemp -d)"
trap 'rm -rf "$DL_DIR"' EXIT

if [ -n "${FEED_SRC_DIR:-}" ]; then
	cp "$FEED_SRC_DIR"/*.apk "$DL_DIR"/ 2>/dev/null || true
	cp "$FEED_SRC_DIR"/*.ipk "$DL_DIR"/ 2>/dev/null || true
else
	require_cmd gh
	# All release tags except the rolling "snapshot" pre-release — the
	# v-prefix filter alone excludes it (its tag is literally "snapshot").
	gh release list --limit 200 --json tagName \
		--jq '.[].tagName | select(startswith("v"))' \
		> "$DL_DIR/tags.txt" || die "gh release list failed"
	[ -s "$DL_DIR/tags.txt" ] || die "no v* releases found — nothing to publish"
	while IFS= read -r tag; do
		[ -n "$tag" ] || continue
		printf 'Fetching assets for %s\n' "$tag"
		gh release download "$tag" --dir "$DL_DIR" \
			--pattern '*.apk' --pattern '*.ipk' --skip-existing \
			|| die "could not download the assets of $tag"
	done < "$DL_DIR/tags.txt"
fi

shopt -s nullglob
for f in "$DL_DIR"/*.apk; do cp "$f" "$APK_DIR/"; done
for f in "$DL_DIR"/*.ipk; do cp "$f" "$OPKG_DIR/"; done
shopt -u nullglob

apk_count=$(find "$APK_DIR" -maxdepth 1 -name '*.apk' | wc -l)
ipk_count=$(find "$OPKG_DIR" -maxdepth 1 -name '*.ipk' | wc -l)
printf 'Collected %s apk and %s ipk package(s)\n' "$apk_count" "$ipk_count"
[ "$apk_count" -gt 0 ] || die "no .apk packages collected"
[ "$ipk_count" -gt 0 ] || die "no .ipk packages collected"

# ---------------------------------------------------------------------------
# apk v3 — build the signed index. Routers add the feed by dropping the
# plain index URL into customfeeds.list
#   https://…/apk/Packages.adb >> /etc/apk/repositories.d/customfeeds.list
# (apk auto-detects the v3 ndx index from the .adb suffix — no prefix needed)
# and trust keys/treadle-feed.pem in /etc/apk/keys/.
#
# The packages themselves were signed with the same key by release.yml, so
# the feed serves the release assets byte for byte. --allow-untrusted only
# relaxes verification on the build host, which does not carry the key in
# /etc/apk/keys; routers verify both the packages and the index.

printf 'Building apk index (Packages.adb)\n'
( cd "$APK_DIR" && apk --allow-untrusted mkndx --sign-key "$APK_SIGN_KEY_FILE" -o Packages.adb ./*.apk )

# ---------------------------------------------------------------------------
# opkg index — Packages (control stanza + Filename/Size/SHA256sum per pkg),
# gzipped, with a detached usign signature over the uncompressed Packages
# (this is what OpenWrt's buildroot signs and what opkg verifies).

printf 'Building opkg index (Packages, Packages.gz, Packages.sig)\n'
PKGFILE="$OPKG_DIR/Packages"
: > "$PKGFILE"

# Emit the raw control.tar.gz bytes from an ipk (a gzip-compressed tar, the
# container package.sh builds). Always pipe these bytes straight into tar —
# never capture them in a shell variable, since command substitution mangles
# the NULs in gzip data.
ipk_control_tar() {
	tar -xzOf "$1" ./control.tar.gz
}

for ipk in "$OPKG_DIR"/*.ipk; do
	fname="$(basename "$ipk")"
	size="$(wc -c < "$ipk")"
	sha="$(sha256sum "$ipk" | awk '{print $1}')"
	# Pull ./control out of the package's control.tar.gz. Extract the
	# control archive once, then try both member spellings against the
	# extracted copy instead of re-running tar over the whole package
	# for the fallback.
	ipk_control_tar "$ipk" > "$DL_DIR/ctrl.tgz"
	ctrl="$(tar -xzOf "$DL_DIR/ctrl.tgz" ./control 2>/dev/null || \
	        tar -xzOf "$DL_DIR/ctrl.tgz" control)"
	{
		printf '%s\n' "$ctrl" | sed '/^[[:space:]]*$/d'
		printf 'Filename: %s\n' "$fname"
		printf 'Size: %s\n' "$size"
		printf 'SHA256sum: %s\n' "$sha"
		printf '\n'
	} >> "$PKGFILE"
done
gzip -9 -k -f "$PKGFILE"
usign -S -m "$PKGFILE" -s "$OPKG_SIGN_KEY_FILE" -x "$OPKG_DIR/Packages.sig"

# ---------------------------------------------------------------------------
# Public keys + landing page.

cp "$KEYS_SRC/treadle-feed.pub"   "$FEED_OUT/keys/treadle-feed.pub"
cp "$KEYS_SRC/treadle-feed.pem" "$FEED_OUT/keys/treadle-feed.pem"

cat > "$FEED_OUT/index.html" <<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Treadle package feed</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  code, pre { background: #f4f4f4; border-radius: 4px; }
  pre { padding: .75rem 1rem; overflow-x: auto; }
  code { padding: .1rem .3rem; }
  pre code { padding: 0; background: none; }
  h2 { margin-top: 2rem; }
  .muted { color: #666; }
</style>
</head>
<body>
<h1>Treadle package feed</h1>
<p>An OpenWrt-style repository for
<a href="https://github.com/routeweave/treadle">luci-app-treadle</a>.
Add it once, then install and upgrade Treadle with your package manager.</p>

<h2>OpenWrt 25.12+ (apk)</h2>
<pre><code>wget -O /etc/apk/keys/treadle-feed.pem ${PAGES_URL}/keys/treadle-feed.pem
echo "${PAGES_URL}/apk/Packages.adb" >> /etc/apk/repositories.d/customfeeds.list
apk update
apk add luci-app-treadle
service rpcd reload</code></pre>

<h2>OpenWrt 24.10 (opkg)</h2>
<pre><code>wget -O /tmp/treadle-feed.pub ${PAGES_URL}/keys/treadle-feed.pub
opkg-key add /tmp/treadle-feed.pub
echo "src/gz treadle ${PAGES_URL}/opkg" >> /etc/opkg/customfeeds.conf
opkg update
opkg install luci-app-treadle
service rpcd reload</code></pre>

<h2>Upgrade</h2>
<pre><code>apk update && apk add -u luci-app-treadle   # 25.12+
opkg update && opkg upgrade luci-app-treadle  # 24.10</code></pre>

<p class="muted">Signed feed. The keys above are published at
<a href="keys/treadle-feed.pem">keys/treadle-feed.pem</a> and
<a href="keys/treadle-feed.pub">keys/treadle-feed.pub</a>.</p>
</body>
</html>
HTML

printf '\nFeed assembled under %s\n' "$FEED_OUT"
printf '  apk:  %s/apk/Packages.adb (+ %s package(s))\n' "$PAGES_URL" "$apk_count"
printf '  opkg: %s/opkg/Packages.gz (+ %s package(s))\n' "$PAGES_URL" "$ipk_count"
