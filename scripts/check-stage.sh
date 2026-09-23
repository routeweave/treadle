#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Syntax-check the staged tree package.sh assembled in .build/stage/, which
# is what actually ships. package.sh strips comment-only lines from every
# script; this catches a stripped line that was not really a comment (a
# line inside a heredoc or a multi-line string), which would otherwise
# only surface on a router.
#
#   scripts/package.sh && sh scripts/check-stage.sh
#
# Requires luac5.1 (or LUAC pointing at a Lua 5.1 compiler) and node.

set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$REPO_DIR/.build/stage"
LUAC="${LUAC:-luac5.1}"

[ -d "$STAGE" ] || { echo "error: $STAGE not found — run scripts/package.sh first" >&2; exit 1; }
command -v "$LUAC" >/dev/null 2>&1 || { echo "error: $LUAC not found" >&2; exit 1; }

fail=0
checked=0

# Classify by shebang rather than by path, so a new script is covered
# without editing this list.
find "$STAGE" -type f ! -path '*/lib/apk/*' | LC_ALL=C sort > "$REPO_DIR/.build/stage-files"
while IFS= read -r f; do
	first=$(head -n1 "$f")
	case "$f:$first" in
		*.js:*)
			node --check "$f" || fail=1 ;;
		*.lua:*|*"#!/usr/bin/env lua"*)
			"$LUAC" -p "$f" || fail=1 ;;
		*"#!/bin/sh"*)
			sh -n "$f" || fail=1 ;;
		*.json:*)
			node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" \
				|| { echo "invalid JSON: $f" >&2; fail=1; } ;;
		*) continue ;;
	esac
	checked=$((checked + 1))
done < "$REPO_DIR/.build/stage-files"

printf '%d staged files checked\n' "$checked"
exit "$fail"
