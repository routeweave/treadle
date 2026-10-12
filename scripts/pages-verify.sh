#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 RouteWeave
#
# Wait until the live Pages site serves this run's deploy, or give up.
#
#   scripts/pages-verify.sh <site-url> <deploy-id> [tries]
#
# pages.yml's build stamps the site with deploy-id.txt (run id and attempt);
# after deploy-pages reports success, this fetches that file until it holds
# this run's stamp. deploy-pages' "success" means GitHub accepted the
# deployment, not that the site serves it: of two deploys of one commit
# seconds apart (a release's and main's CI, every release), the earlier can
# stay live.
#
# The query string differs on every try, so the request reaches GitHub's
# origin instead of a cached copy. Tries are 10 s apart (default 18, about 3
# minutes). Exit 0 when the stamp matches, 1 otherwise.

set -u

url="${1:?site url}"
want="${2:?deploy id}"
tries="${3:-18}"
url="${url%/}/deploy-id.txt"

got=""
i=1
while [ "$i" -le "$tries" ]; do
	got=$(curl -fsS -m 10 "$url?try=$i.$$" 2>/dev/null | head -n 1)
	if [ "$got" = "$want" ]; then
		echo "the site serves this deploy ($want), after about $(( (i - 1) * 10 )) s"
		exit 0
	fi
	sleep 10
	i=$((i + 1))
done
echo "the site still serves '${got:-nothing}', not this deploy ($want), after $tries tries"
exit 1
