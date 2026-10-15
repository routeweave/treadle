#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Decides whether a CI run releases, from the Makefile's PKG_VERSION /
# PKG_RELEASE and the v* tags that exist. ci.yml's version job runs it on
# every run, so a wrong bump fails its own pull request; see
# docs/versioning.md.
#
#   decide-release.sh [MAKEFILE]
#
# Environment:
#   EVENT, GITHUB_REF, DRY_RUN  the run asking: github.event_name, github.ref
#                               and the release_dry_run input
#   TAGS                        the v* tags, one per line; when unset they are
#                               listed from origin with git ls-remote
#   GITHUB_OUTPUT               where a release's tag, version and release
#                               are written; stdout when unset
#
# Exits 0 with nothing written when the run is not a release, 0 with the
# three outputs when it is, and 1 when the Makefile's version is wrong.
# check-decide-release.sh runs it against a matrix of cases.

set -eu

MAKEFILE=${1:-Makefile}
EVENT=${EVENT:-}
GITHUB_REF=${GITHUB_REF:-}
DRY_RUN=${DRY_RUN:-}
OUT=${GITHUB_OUTPUT:-/dev/stdout}

mk_var() {
	awk -F':=' -v key="$1" \
		'$1 == key { sub(/^[ \t]+/, "", $2); sub(/[ \t]+$/, "", $2); print $2; exit }' \
		"$MAKEFILE"
}
VERSION=$(mk_var PKG_VERSION)
RELEASE=$(mk_var PKG_RELEASE)
[ -n "$VERSION" ] || { echo "::error::no PKG_VERSION in $MAKEFILE"; exit 1; }
case "$RELEASE" in
	[1-9]|[1-9][0-9]) ;;
	*) echo "::error::PKG_RELEASE is '$RELEASE', not a number from 1"; exit 1 ;;
esac
# v0.1.0 for release 1, v0.1.0-r2 for a packaging-only change to the same code.
if [ "$RELEASE" = 1 ]; then TAG="v$VERSION"; else TAG="v$VERSION-r$RELEASE"; fi

# Listed on every run, so a wrong bump fails its own pull request.
# ls-remote exits non-zero when it cannot ask, so an unreachable remote fails
# the run instead of reading as "no tags".
if [ "${TAGS+set}" != set ]; then
	TAGS=$(git ls-remote --tags --refs origin 'v[0-9]*') || { echo "::error::could not list the tags"; exit 1; }
	TAGS=$(printf '%s\n' "$TAGS" | sed -n 's|.*refs/tags/||p')
fi

if printf '%s\n' "$TAGS" | grep -qxF "$TAG"; then
	if [ "$EVENT:$DRY_RUN" != workflow_dispatch:true ]; then
		echo "not a release: $TAG is already released"
		exit 0
	fi
else
	# A new version that sorts below the newest release is a typo in the
	# Makefile, not a release: routers would never upgrade to it.
	# sort -V puts v0.1.0 < v0.1.0-r2 < v0.1.0-r10 < v0.2.0.
	last=$(printf '%s\n' "$TAGS" | sed '/^$/d' | sort -V | tail -n 1)
	newest=$(printf '%s\n%s\n' "$last" "$TAG" | sed '/^$/d' | sort -V | tail -n 1)
	if [ "$newest" != "$TAG" ]; then
		echo "::error::the Makefile names $TAG, which sorts below the newest release $last"
		exit 1
	fi
	# A new PKG_VERSION starts again at PKG_RELEASE 1.
	last_version=${last#v}; last_version=${last_version%-r*}
	if [ "$VERSION" != "$last_version" ] && [ "$RELEASE" != 1 ]; then
		echo "::error::PKG_VERSION moves from $last_version to $VERSION, so PKG_RELEASE goes back to 1"
		exit 1
	fi
fi

case "$EVENT:$GITHUB_REF:$DRY_RUN" in
	push:refs/heads/main:*)
		echo "::notice::release commit: this run releases $TAG" ;;
	workflow_dispatch:*:true)
		echo "release dry run of $TAG" ;;
	*)
		echo "not a release: $EVENT on $GITHUB_REF ($TAG would be released on main)"
		exit 0 ;;
esac
{
	echo "tag=$TAG"
	echo "version=$VERSION"
	echo "release=$RELEASE"
} >> "$OUT"
