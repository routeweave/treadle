#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Add the rolling snapshot of main to the Pages site that feed.sh built, as
# $FEED_OUT/snapshot/luci-app-treadle-snapshot.{apk,ipk} plus a .sha256 for
# each and a VERSION file. Run by pages.yml.
#
# When ci.yml publishes a main build, the packages it just tested are in
# $SNAPSHOT_DIR. Every other run (a release, a manual rebuild) keeps the
# files the live site serves now, so the snapshot only ever moves to a newer
# tested main. With neither (the very first deploy), the site simply has no
# snapshot yet.
#
# Environment:
#   FEED_OUT          the site directory
#   PAGES_URL         the site's public URL, for keeping the live snapshot
#   SNAPSHOT_DIR      optional: a directory holding the build's .apk and .ipk
#   SNAPSHOT_COMMIT   the commit that build is from, recorded in VERSION

set -eu

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ -n "${FEED_OUT:-}" ] || die "FEED_OUT is not set"

OUT="$FEED_OUT/snapshot"
NAME=luci-app-treadle-snapshot
mkdir -p "$OUT"

from_build() {
	[ -n "${SNAPSHOT_DIR:-}" ] || return 1
	for ext in apk ipk; do
		src=$(find "$SNAPSHOT_DIR" -type f -name "*.$ext" | head -n 1)
		[ -n "$src" ] || die "no .$ext in $SNAPSHOT_DIR"
		cp "$src" "$OUT/$NAME.$ext"
	done
	version=$(basename "$(find "$SNAPSHOT_DIR" -type f -name '*.apk' | head -n 1)" .apk)
	version=${version#luci-app-treadle-}
	printf 'version %s\ncommit %s\n' "$version" "${SNAPSHOT_COMMIT:-unknown}" > "$OUT/VERSION"
	printf 'snapshot: %s from this run\n' "$version"
}

from_live() {
	[ -n "${PAGES_URL:-}" ] || return 1
	for f in "$NAME.apk" "$NAME.ipk" VERSION; do
		curl -fsSL -o "$OUT/$f" "${PAGES_URL%/}/snapshot/$f" || return 1
	done
	printf 'snapshot: keeping the live one (%s)\n' \
		"$(sed -n 's/^version //p' "$OUT/VERSION")"
}

if ! from_build && ! from_live; then
	rm -rf "$OUT"
	printf 'snapshot: none available yet, site published without one\n'
	exit 0
fi

# Checksums under the published names, so `sha256sum -c` works as-is.
( cd "$OUT" && for ext in apk ipk; do sha256sum "$NAME.$ext" > "$NAME.$ext.sha256"; done )
ls -l "$OUT"
