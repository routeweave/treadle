# Contributing to Treadle

Thanks for poking at the code. This file covers building, testing, the
repository layout and the coding conventions. How the pieces fit together
and why is in [docs/design.md](docs/design.md).

## Building from source

### Standalone (no OpenWrt SDK)

Requires `apk` (apk-tools 3.x with `mkpkg`), `fakeroot`, `tar`, `gzip`,
`find`, `wc`. Distributions without apk-tools 3.x packaged need to
build it from source — see `.github/actions/install-apk-tools/action.yml`
for the exact invocation CI uses.

```sh
scripts/package.sh
# → dist/luci-app-treadle-<version>-r<release>.apk
# → dist/luci-app-treadle_<version>-r<release>_all.ipk
```

The `Makefile` is the single source of truth for package metadata
(`PKG_VERSION`, `LUCI_DEPENDS`, conffiles, …). `package.sh` parses those
values out — never edit them in `package.sh`.

### Using the OpenWrt SDK

```sh
cp -r /path/to/treadle <sdk>/package/luci-app-treadle
make package/luci-app-treadle/compile V=s
```

Output: `bin/packages/<arch>/base/luci-app-treadle_*.apk`

### Checks

Run these before pushing; CI runs the same ones on every pull request.

```sh
sh scripts/lint.sh                    # shellcheck, luacheck, eslint
scripts/package.sh && sh scripts/check-stage.sh   # build, then syntax-check what ships
docker run --rm -v "$PWD:/work" openwrt/rootfs:x86_64-25.12.4 \
    /bin/sh /work/tests/smoke.sh      # end-to-end on OpenWrt (needs dist/)
```

`lint.sh` needs shellcheck 0.10 or newer (for the busybox dialect),
luacheck and npx. `check-stage.sh` needs `luac5.1` and node.
`tests/smoke.sh` installs the built package in an OpenWrt container with
the real sing-box, syncs the synthetic subscriptions in
`tests/fixtures/sub/`, and runs `sing-box check` on every config shape
`build-config` produces. Fixtures use placeholder values only.

### Installing your build on a router

```sh
scp dist/luci-app-treadle_*.apk root@192.168.1.1:/tmp/
ssh root@192.168.1.1 'apk add --allow-untrusted /tmp/luci-app-treadle_*.apk && service rpcd reload'
```

## Versioning

Full rules, including the apk and opkg format constraints, live in
[`docs/versioning.md`](docs/versioning.md). Read that before changing
anything in the packaging pipeline. The shapes:

| Situation                                       | Example version              |
|---|---|
| Release (CI from tag `v0.1.0`)                  | `0.1.0-r1`                   |
| Packaging re-release (CI from tag `v0.1.0-r2`)  | `0.1.0-r2`                   |
| Snapshot past `v0.1.0`                          | `0.1.0_git20260105083000-r1` |
| Snapshot, no `v*` tag yet (bootstrap)           | `0.1.0_pre20260105083000-r1` |

Three rules carry most of it:

- `PKG_VERSION` / `PKG_RELEASE` in the `Makefile` are authoritative and
  **trail** the timeline — they name the version most recently released.
  The `v*` tag is the release decision, and `release.yml` fails the
  release if the two disagree rather than overriding the Makefile.
- The snapshot suffix is HEAD's **commit timestamp**, never a commit
  count. A count collides across branches and moves backwards when a
  branch is rebased.
- `-r<N>` is the **packaging revision** and nothing else, for both
  package formats. It is never a build counter.

`version-check.sh` asserts these against apk's own parser and runs in
both workflows. With an `apk` on PATH it also runs locally:

```sh
scripts/version-check.sh
```

## Releasing

Releases are an explicit, deliberate act — pushing a `v*` tag is the
release decision. Merges to `main` do not trigger releases.

```sh
# After merging the changes that constitute the release to main:
git checkout main && git pull
$EDITOR Makefile            # PKG_VERSION:=0.2.0
git commit -am "Release 0.2.0"
git push

git tag -a v0.2.0 -m "Release 0.2.0"
git push origin v0.2.0
```

Record the version being released in the Makefile first — the tag must
match it, or `release.yml` fails the release rather than guessing which
of the two is right. `PKG_RELEASE` resets to `1` whenever `PKG_VERSION`
changes; bump only `PKG_RELEASE` for a packaging-only re-release of the
same source, and tag that `v0.2.0-r2`.

Snapshots from the next commit on are `0.2.0_git<timestamp>-r1`
automatically.

## CI

| Workflow | Trigger | What it does |
|---|---|---|
| **CI**      | Pull request, push to `main` | Lint, package build and staged-tree check, smoke test on OpenWrt 25.12 (apk) and 24.10 (opkg). On a `main` push that passes, also publishes the rolling snapshot. |
| **Release** | Push of a `v*` tag           | Builds, signs the `.apk` with the feed key, and creates an immutable GitHub release. |
| **Feed**    | After a successful Release   | Rebuilds the signed GitHub Pages feed from every `v*` release. |

Every action is pinned to a commit SHA, with the tag in a trailing comment;
Dependabot proposes updates monthly.

### What a snapshot is

The latest `main` that passed CI, published as the rolling `snapshot`
pre-release under a stable URL. Every merge that passes replaces it.

To try a branch before it merges, use that branch's own CI build: each
run uploads its packages as a workflow artifact (kept 30 days), and
`scripts/push-to-router.sh` installs the newest successful build of the
branch you have checked out.

## Repository layout

```
.github/
├── actions/install-apk-tools/   # CI: build apk-tools 3.x
├── actions/install-usign/       # CI: build OpenWrt's usign
├── dependabot.yml               # Keeps the pinned actions current
└── workflows/
    ├── ci.yml                   # Checks on every PR; snapshot from main
    ├── release.yml              # Release on v* tag push
    └── pages.yml                # Publish the feed to GitHub Pages
scripts/
├── package.sh                   # Standalone APK + IPK builder
├── check-stage.sh               # Syntax-check the tree package.sh stages
├── lint.sh                      # shellcheck + luacheck + eslint
├── version-check.sh             # Version scheme asserted against apk's parser
├── feed.sh  feed-keygen.sh      # Signed apk + opkg feed assembly, key setup
├── release-notes.sh             # Shared release/snapshot notes body
└── push-to-router.sh            # Install a branch's CI build on a router
tests/
├── smoke.sh                     # End-to-end test in an OpenWrt container
└── fixtures/sub/                # Synthetic subscriptions, all four formats
Makefile                         # OpenWrt SDK build descriptor (luci.mk)
htdocs/luci-static/resources/view/treadle/
├── main.js                      # Host view — the tab shell
├── status.js  nodes.js  routing.js  settings.js   # One panel per tab
└── lib/                         # Shared view helpers (formpanel, ordersave)
root/
├── etc/
│   ├── config/treadle           # Default UCI config (conffile)
│   ├── init.d/treadle           # procd init script
│   └── treadle/extra.json       # Advanced overrides (conffile)
└── usr/
    ├── libexec/treadle/         # build-config, firewall.sh, fetch-catalog,
    │                            #   sync-subscriptions, watchdog, hourly, treadlelib.lua
    ├── libexec/rpcd/luci.treadle  # rpcd handler
    └── share/
        ├── luci/menu.d/luci-app-treadle.json
        └── rpcd/acl.d/luci-app-treadle.json
po/templates/luci-app-treadle.pot  # Gettext translation template
```

## Conventions

Treadle runs on routers with little memory and slow CPUs, so resource
limits are hard requirements, not preferences.

### Resources

- No JavaScript frameworks; LuCI's own JS API only. No bundled fonts or
  icon sets.
- Fetch data over RPC after the page loads; never inline large JSON in
  rendered HTML.
- rpcd starts a new process for every call. A view that refreshes should
  get everything it needs from one call, and keep expensive work (reading
  the whole syslog, building a config) off its fast path.
- Repeated refreshes use one `setTimeout` rescheduled after each response,
  never `setInterval`, and stop when the view is torn down.
- Do not write files on every request. Keep runtime state on tmpfs
  (`/var/etc/treadle/`) and write to flash only what must survive a reboot.

### LuCI views

- Views are LuCI JS modules: `'use strict';`, `'require …'` lines, then
  `return view.extend({…})` (or `baseclass.extend` for a panel). Tabs,
  single-quoted strings (as LuCI itself), `E()` for DOM — never
  `innerHTML`.
- Every user-visible string goes through `_()`.
- Talk to the router only through `rpc.declare()`; raw `fetch` / XHR
  bypass LuCI's session and CSRF handling.
- Settings pages use `form.Map` and its sections and options; build rows
  by hand only for genuinely custom UI, and then use LuCI's classes
  (`cbi-section`, `cbi-value`, `table cbi-section-table`, `btn cbi-button
  cbi-button-*`) so every theme styles them. `cbi-page-actions` sits
  directly inside `cbi-map`.
- Small inline `style=` is fine where LuCI has no class for it; do not
  restyle what a LuCI class already styles.
- Status badges: `label success` / `label warning` work on every theme.
  There is no portable red label class; set the background inline from
  the theme's danger/error variable with a literal fallback.

`scripts/lint.sh` enforces the mechanical parts of this (eslint forbids
`innerHTML`, `setInterval`, raw `fetch` and `XMLHttpRequest`).

### UCI sections

Every section except the fixed ones (`global`, `basic`, `inbounds`, `dns`,
`routing`) is a named section whose name is a random 16-hex id — the only
id, used by every cross-reference (see docs/design.md). When creating one:

- **JS:** `'require view.treadle.uid as uid';` and
  `uci.add('treadle', '<type>', uid.generate())`. Grid sections override
  `handleAdd` so the id exists before the edit modal opens.
- **Lua:** `c:set("treadle", uid, "<type>")`.

Never add a separate id option, and never persist libuci's `cfgXXXX`
names.

### Shell (router side)

- POSIX sh for busybox ash: `#!/bin/sh` (init scripts
  `#!/bin/sh /etc/rc.common`), no bash-isms, no `local` with assignment.
- Quote every expansion. When a value from UCI or the network reaches a
  command line, validate it first and single-quote it.
- Anything that can interrupt connectivity (firewall, DNS, service
  restarts) must never tear down before the replacement is ready.

### Lua

- Lua 5.1 exactly: no `goto`, integer division, bitwise operators,
  `<close>`, `table.move` or `string.pack`. A newer local Lua is not a
  valid syntax check; `lint.sh` runs luacheck in 5.1 mode.
- UCI through the raw binding, `require("uci").cursor()`, and close every
  cursor explicitly.
- `require` modules inside the function that needs them when they are not
  always needed.
- rpcd methods always exit 0 and report failure in their JSON reply; a
  non-zero exit reaches LuCI as "Object not found".

### Files and packaging

- Every source file starts with `SPDX-License-Identifier: GPL-3.0-only`
  and a `Copyright` line in its comment syntax; `package.sh` strips other
  comment-only lines from the installed copy and keeps these.
- Package metadata, dependencies, conffiles and the install scripts live
  only in the `Makefile`.
- Executables under `root/` keep mode `100755` in git.

### Commits

- One logical change per commit, with a message that explains why.
- Test fixtures and examples use placeholder values only: `example.com`,
  RFC 5737 addresses (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`),
  the all-zero UUID, `<password>`. Never paste a real subscription, node,
  or router log or config.

## Branch naming

Short, descriptive kebab-case topic branches: `view-subscription-nodes`,
`fix-dnsmasq-confdir`, `migrate-wireguard-endpoint`. Avoid auto-generated
session-style names like `claude/foo-bar-1234`.

## Translations

Translatable strings in JS views use `_(…)`. The `.pot` template is
extracted at build time and lives at `po/templates/luci-app-treadle.pot`.
Add `.po` files under `po/<lang>/luci-app-treadle.po`.
