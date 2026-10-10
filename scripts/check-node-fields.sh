#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# A manual node's settings travel two ways: the node editor writes them to UCI
# and build_node_from_uci (build-config) reads them back; a pasted share link goes
# the other way, through outbound_to_uci (subparse.lua). The second must gain a
# line whenever the first gains a field. This makes that rule fail a build
# instead of relying on someone remembering it:
#
#   sh scripts/check-node-fields.sh
#
# It compares the field names build_node_from_uci and the two helpers it calls
# (build_tls_from_uci, build_transport_from_uci) read with the ones
# outbound_to_uci can write. A field the builder reads and the link import
# cannot write is a gap, unless it belongs to a node kind that has no share-link
# form at all (below). A field the import writes and the builder never reads is
# a mapping that silently goes nowhere.
#
# smoke.sh checks the same thing by behaviour: fixture links must round-trip to
# the outbound the subscription path builds. Together they cover both a field
# no fixture link carries and a link whose mapping is wrong.

set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# The two paths can be overridden to try the check against a modified copy.
BUILDER="${NODE_FIELDS_BUILDER:-$REPO_DIR/root/usr/libexec/treadle/build-config}"
HANDLER="${NODE_FIELDS_HANDLER:-$REPO_DIR/root/usr/libexec/treadle/subparse.lua}"

# Field names (or prefixes ending in `_`) read by the builder with no share-link
# form to map from. Add to this only for a node kind a link cannot describe, and
# say which kind; a field of a link-capable protocol belongs in outbound_to_uci.
#   override_*  the `direct` outbound
#   group_*     group nodes
#   wg_*        WireGuard endpoints
EXEMPT='^(override_|group_|wg_)'

# Body of a top-level `local function NAME(` up to its closing `end` in column 0.
body() {
	awk -v n="$2" '$0 ~ "^local function " n "\\(" { on = 1 } on { print } on && /^end$/ { exit }' "$1"
}

tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT

for fn in build_tls_from_uci build_transport_from_uci build_node_from_uci; do
	body "$BUILDER" "$fn"
done \
	| grep -oE '\bs\.[a-z_0-9]+|\bs\["[a-z_0-9]+"\]|uci_list\(s, "[a-z_0-9]+"\)' \
	| sed -E 's/^s\.//; s/^s\["//; s/"\]$//; s/^uci_list\(s, "//; s/"\)$//' \
	| sort -u > "$tmp/read"

body "$HANDLER" outbound_to_uci \
	| grep -oE 'put\("[a-z_0-9]+"|\bf\.[a-z_0-9]+ *=|\bf\["[a-z_0-9]+"\] *=' \
	| sed -E 's/^put\("//; s/"$//; s/^f\.//; s/ *=$//; s/^f\["//; s/"\] *=$//' \
	| sort -u > "$tmp/write"

# A rename of either function would otherwise leave both lists empty and the
# check passing for nothing.
reads=$(wc -l < "$tmp/read" | tr -d ' ')
writes=$(wc -l < "$tmp/write" | tr -d ' ')
if [ "$reads" -lt 40 ] || [ "$writes" -lt 30 ]; then
	printf 'node fields: found only %s read and %s written field names; the extraction needs updating for a changed function\n' \
		"$reads" "$writes" >&2
	exit 1
fi

status=0
gaps=$(comm -23 "$tmp/read" "$tmp/write" | grep -Ev "$EXEMPT")
if [ -n "$gaps" ]; then
	status=1
	printf 'node fields: build_node_from_uci reads these, but outbound_to_uci never writes them,\n'
	printf 'so a share link cannot fill them in (add them to outbound_to_uci, or to EXEMPT\n'
	printf 'in %s if the node kind has no share-link form):\n' "scripts/check-node-fields.sh"
	# shellcheck disable=SC2086  # one name per word, no spaces
	printf '    %s\n' $gaps
fi
dead=$(comm -13 "$tmp/read" "$tmp/write")
if [ -n "$dead" ]; then
	status=1
	printf 'node fields: outbound_to_uci writes these, but build_node_from_uci never reads them\n'
	printf '(a link would fill in a setting that has no effect):\n'
	# shellcheck disable=SC2086
	printf '    %s\n' $dead
fi
[ "$status" -eq 0 ] && printf 'node fields: %s read, %s written, in step\n' "$reads" "$writes"
exit "$status"
