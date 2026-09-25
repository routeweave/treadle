#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Add the rolling snapshot of main to the Pages site that feed.sh built, as
# $FEED_OUT/snapshot/luci-app-treadle-snapshot.{apk,ipk} plus a .sha256 for
# each and a VERSION file. Run by pages.yml.
#
# The packages come from a CI run's `packages-<sha>` artifact:
# $TRIGGER_RUN when a CI run triggered this, otherwise the newest successful
# CI run on a push to main. CI keeps those artifacts for 30 days; when none
# is left, the files the live site serves now are kept, so a quiet month
# never makes the snapshot disappear. With neither (the very first deploy),
# the site simply has no snapshot yet.
#
# Environment:
#   GH_TOKEN          token with actions:read, for gh
#   GITHUB_REPOSITORY owner/repo (set by Actions)
#   FEED_OUT          the site directory
#   PAGES_URL         the site's public URL, for the keep-what-is-live fallback
#   TRIGGER_RUN       optional: the CI run id to take the packages from

set -eu

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
[ -n "${FEED_OUT:-}" ] || die "FEED_OUT is not set"
[ -n "${GITHUB_REPOSITORY:-}" ] || die "GITHUB_REPOSITORY is not set"

OUT="$FEED_OUT/snapshot"
NAME=luci-app-treadle-snapshot
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

run=${TRIGGER_RUN:-}
if [ -z "$run" ]; then
	run=$(gh run list -R "$GITHUB_REPOSITORY" --workflow ci.yml --branch main \
		--event push --status success --limit 1 \
		--json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)
fi

from_ci() {
	[ -n "$run" ] || return 1
	gh run download "$run" -R "$GITHUB_REPOSITORY" --pattern 'packages-*' \
		--dir "$TMP/ci" >/dev/null 2>&1 || return 1
	for ext in apk ipk; do
		src=$(find "$TMP/ci" -type f -name "*.$ext" | head -n 1)
		[ -n "$src" ] || return 1
		cp "$src" "$OUT/$NAME.$ext"
	done
	version=$(basename "$(find "$TMP/ci" -type f -name '*.apk' | head -n 1)" .apk)
	version=${version#luci-app-treadle-}
	commit=$(gh run view "$run" -R "$GITHUB_REPOSITORY" --json headSha --jq .headSha 2>/dev/null || true)
	printf 'version %s\ncommit %s\n' "$version" "${commit:-unknown}" > "$OUT/VERSION"
	printf 'snapshot: %s from CI run %s\n' "$version" "$run"
}

from_live() {
	[ -n "${PAGES_URL:-}" ] || return 1
	for f in "$NAME.apk" "$NAME.ipk" VERSION; do
		curl -fsSL -o "$OUT/$f" "${PAGES_URL%/}/snapshot/$f" || return 1
	done
	printf 'snapshot: no CI build available, keeping the live one (%s)\n' \
		"$(sed -n 's/^version //p' "$OUT/VERSION")"
}

if ! from_ci && ! from_live; then
	rm -rf "$OUT"
	printf 'snapshot: none available yet, site published without one\n'
	exit 0
fi

# Checksums under the published names, so `sha256sum -c` works as-is.
( cd "$OUT" && for ext in apk ipk; do sha256sum "$NAME.$ext" > "$NAME.$ext.sha256"; done )
ls -l "$OUT"
