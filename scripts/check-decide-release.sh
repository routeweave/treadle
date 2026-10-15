#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Runs decide-release.sh against a matrix of tags, Makefile versions and CI
# events, so the release decision ci.yml makes on every run is tested before
# it reaches main. lint.sh runs it.
#
#   sh scripts/check-decide-release.sh

set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# One case per line: tags (comma-separated, - for none) | PKG_VERSION |
# PKG_RELEASE | event | ref | release_dry_run | expected. The expected
# outcome is the tag released, "none" for a run that does not release, or
# "error" for a version CI must refuse.
CASES="
-|0.1.0|1|push|refs/heads/main||v0.1.0
-|0.1.0|2|push|refs/heads/main||error
v0.19.1|0.19.1|1|push|refs/heads/main||none
v0.19.1|0.19.1|1|pull_request|refs/pull/1/merge||none
v0.19.1|0.20.0|1|push|refs/heads/main||v0.20.0
v0.19.1|0.20.0|1|pull_request|refs/pull/1/merge||none
v0.19.1|0.20.0|1|push|refs/heads/other||none
v0.19.1|0.20.0|1|workflow_dispatch|refs/heads/other|false|none
v0.19.1|0.20.0|1|workflow_dispatch|refs/heads/other|true|v0.20.0
v0.19.1|0.19.1|1|workflow_dispatch|refs/heads/other|true|v0.19.1
v0.19.1|0.19.1|2|push|refs/heads/main||v0.19.1-r2
v0.19.0,v0.19.1,v0.19.1-r2|0.19.1|10|push|refs/heads/main||v0.19.1-r10
v0.9.0|0.10.0|1|push|refs/heads/main||v0.10.0
v0.19.1|0.19.0|1|pull_request|refs/pull/1/merge||error
v0.19.1|0.19.0|1|push|refs/heads/main||error
v0.19.1-r2|0.19.1|1|push|refs/heads/main||error
v0.19.1|0.20.0|2|pull_request|refs/pull/1/merge||error
v0.19.1|0.19.1|0|push|refs/heads/main||error
v0.19.1|0.19.1||push|refs/heads/main||error
v0.19.1||1|push|refs/heads/main||error
"

fail=0
n=0
printf '%s\n' "$CASES" | {
	while IFS='|' read -r tags version release event ref dry expect; do
		[ -n "$expect" ] || continue
		n=$((n + 1))
		mk="$WORK/Makefile"
		out="$WORK/output"
		: > "$out"
		{
			[ -z "$version" ] || echo "PKG_VERSION:=$version"
			[ -z "$release" ] || echo "PKG_RELEASE:=$release"
		} > "$mk"
		[ "$tags" = - ] && tags=
		tags=$(printf '%s' "$tags" | tr ',' '\n')

		if TAGS="$tags" EVENT="$event" GITHUB_REF="$ref" DRY_RUN="$dry" \
			GITHUB_OUTPUT="$out" sh "$REPO_DIR/scripts/decide-release.sh" "$mk" \
			> "$WORK/log" 2>&1; then
			got=$(sed -n 's/^tag=//p' "$out")
			[ -n "$got" ] || got=none
		else
			got=error
		fi

		label="$event $ref${dry:+ dry=$dry}, tags [$(printf '%s' "$tags" | tr '\n' ' ')], Makefile $version r$release"
		if [ "$got" = "$expect" ]; then
			printf '  ok    %s → %s\n' "$label" "$got"
		else
			printf '  FAIL  %s → %s, expected %s\n' "$label" "$got" "$expect"
			sed 's/^/          /' "$WORK/log"
			fail=1
		fi
	done
	if [ "$fail" -ne 0 ]; then
		printf 'check-decide-release: FAILED\n' >&2
		exit 1
	fi
	printf 'check-decide-release: %d cases passed\n' "$n"
}
