#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Emit the release-notes body shared by ci.yml (snapshot) and release.yml:
# header lines from stdin first, then the APK / IPK install instructions
# for the two given asset URLs. One copy so the wording cannot drift
# between the rolling snapshot and tagged releases (the two inline
# copies it replaces already had).
#
# Usage: release-notes.sh <apk-url> <ipk-url>  (header on stdin)

set -eu

APK_URL="$1"
IPK_URL="$2"

cat

cat <<EOF

**APK** (OpenWrt 25.12+)
_apk-tools 3.x does not accept remote URLs directly — download first._
\`\`\`
wget -O /tmp/treadle.apk ${APK_URL} && apk add --allow-untrusted /tmp/treadle.apk && service rpcd reload
\`\`\`

**IPK** (OpenWrt ≤24.10 / opkg)
\`\`\`
wget -O /tmp/treadle.ipk ${IPK_URL} && opkg install /tmp/treadle.ipk && service rpcd reload
\`\`\`
EOF
