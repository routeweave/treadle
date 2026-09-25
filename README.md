# Treadle

A LuCI web UI for [sing-box](https://sing-box.sagernet.org/) on OpenWrt.
Manage subscriptions, routing, rule-sets, and DNS from the router admin
page — no JSON to hand-edit.

## Features

- **One LuCI page** at *Services → Treadle*. A Basic/Advanced toggle in
  the tab bar swaps between a tight surface (Status + Basic) and the
  full one (Status, Nodes, Routing, Settings). Switching is
  non-destructive — your Advanced config stays on disk.
- **Subscriptions and manual nodes.** Fetch and refresh remote node
  lists; hand-add nodes for VLESS, VMess, Trojan, Shadowsocks,
  Hysteria2, TUIC, AnyTLS, WireGuard, and SOCKS.
- **Selectors and urltest groups.** Pick servers manually or let Treadle
  pick the fastest; per-node latency testing is built in.
- **Routing rules with AND/OR conditions** — domain match, IP/CIDR,
  rule-set, protocol, port. Each rule has its own outbound.
- **Rule-set management.** Local sources, scheduled refresh, generated
  config plumbing.
- **DNS** with multiple upstreams, fake-IP, and per-rule resolution.
- **Transparent capture** in TProxy or TUN mode, on the router itself.
- **Safe applies.** `sing-box check` runs before every restart; a
  broken save keeps the running config alive.
- **UCI-backed.** All settings live in `/etc/config/treadle`; the
  sing-box JSON is generated on save.

## Install

SSH into the router, then paste one of the commands below.

### From the Treadle feed (recommended)

Add the Treadle package feed once and your package manager handles
install *and* upgrades — no chasing release URLs. The feed is signed;
you import its public key the first time.

**OpenWrt 25.12+** (apk):

```sh
wget -O /etc/apk/keys/treadle-feed.pem https://routeweave.github.io/treadle/keys/treadle-feed.pem
echo "https://routeweave.github.io/treadle/apk/Packages.adb" >> /etc/apk/repositories.d/customfeeds.list
apk update && apk add luci-app-treadle && service rpcd reload
```

**OpenWrt 24.10** (opkg):

```sh
wget -O /tmp/treadle-feed.pub https://routeweave.github.io/treadle/keys/treadle-feed.pub
opkg-key add /tmp/treadle-feed.pub
echo "src/gz treadle https://routeweave.github.io/treadle/opkg" >> /etc/opkg/customfeeds.conf
opkg update && opkg install luci-app-treadle && service rpcd reload
```

Later, upgrade in place:

```sh
apk update && apk add -u luci-app-treadle    # 25.12+
opkg update && opkg upgrade luci-app-treadle # 24.10
```

The feed indexes every tagged release; see
<https://routeweave.github.io/treadle/> for the live instructions.

### Tagged release

The [latest release](../../releases/latest) page has a copy-paste
one-liner with the version baked in — open it, copy the install
command from the notes, paste it on the router. The shape is:

**OpenWrt 25.12+** (APK):

```sh
wget -O /tmp/treadle.apk <release-asset-url> && apk add --allow-untrusted /tmp/treadle.apk && service rpcd reload
```

**OpenWrt 24.10** (opkg):

```sh
wget -O /tmp/treadle.ipk <release-asset-url> && opkg install /tmp/treadle.ipk && service rpcd reload
```

Then open `http://<router>/cgi-bin/luci/admin/services/treadle` and add
your first subscription from the **Basic** tab (or **Nodes** in
Advanced mode).

### Snapshot (bleeding edge)

> **Warning.** A snapshot is the latest `main` that passed CI — merged
> code that has not been released yet. It has passed the automated
> checks but has not had the testing a release gets, and it can change
> UCI shape or behaviour without notice.
>
> It is most useful for trying a fix before it is released, usually
> when someone asks you to verify one. For anything you depend on, use a
> tagged release.

The snapshot URL is stable — the same one-liner installs and upgrades.
It is served from the feed's site; `…/snapshot/VERSION` names the build
and commit.

**OpenWrt 25.12+** (APK):

```sh
wget -O /tmp/treadle.apk https://routeweave.github.io/treadle/snapshot/luci-app-treadle-snapshot.apk && apk add --allow-untrusted /tmp/treadle.apk && service rpcd reload
```

**OpenWrt 24.10** (opkg):

```sh
wget -O /tmp/treadle.ipk https://routeweave.github.io/treadle/snapshot/luci-app-treadle-snapshot.ipk && opkg install /tmp/treadle.ipk && service rpcd reload
```

### On iStoreOS and other OpenWrt forks

iStoreOS is a downstream OpenWrt distribution; its active branch,
`istoreos-24.10`, is OpenWrt **24.10** with **opkg / IPK**. Use the
**OpenWrt 24.10 (opkg)** instructions above unchanged — no
iStoreOS-specific build exists or is needed. Run `opkg update` first: the
24.10 feed it inherits ships sing-box 1.12.x (well past Treadle's `≥1.12`
floor), and fw4/nftables is present by default. The same reasoning
applies to other 24.10-based forks; a 25.12-based fork would use the apk
instructions.

One caveat unique to these forks: they make one-click proxy tools
(OpenClash, PassWall, ShellCrash, …) easy to install, and each manages
its own nftables redirect/TPROXY rules. Running one of those *and* Treadle's
transparent capture at the same time will conflict at runtime. Enable only
one. Treadle's rules live in their own table, so you can see what is loaded
with `nft list table inet treadle`.

## Requirements

- OpenWrt **24.10** or **25.12+** (including forks such as iStoreOS —
  see above).
- **sing-box ≥ 1.12** (pulled in as a dependency).
- **nftables.** Treadle installs its own `inet treadle` table via `nft`;
  iptables / fw3 are not supported. Both 24.10 and 25.12 ship
  fw4/nftables by default, so a stock install already qualifies.

Everything else (`luci-base`, `luci-lib-jsonc`, `rpcd`,
`uclient-fetch`, `ca-bundle`, `lua`, `libuci-lua`, `nftables-json`) is
pulled in automatically.

## Upgrade and uninstall

Re-running the install one-liner replaces the package in place.
`/etc/config/treadle` is marked as a conffile, so your settings survive
upgrades.

To remove:

```sh
apk del luci-app-treadle          # OpenWrt 25.12+
opkg remove luci-app-treadle      # OpenWrt 24.10
```

The service stops and the package is removed; `/etc/config/treadle` is
preserved unless you also `rm` it.

## Troubleshooting

**Logs.** Status tab → *View full log*, or from a shell:

```sh
logread -e treadle
logread -e sing-box
```

**Generated sing-box config.** Status tab → *View generated config*,
or:

```sh
cat /var/etc/treadle/sing-box.json
```

**Service won't start.** Treadle runs `sing-box check` before every
restart and refuses to swap in a broken config — the previous one keeps
running. The rejection reason shows up in the Treadle log.

**Stop without uninstalling.** Status tab → *Stop*, and toggle
*Autostart* off to keep it from coming back on reboot.

**Reset to defaults.**

```sh
rm /etc/config/treadle
apk add --force-overwrite --allow-untrusted /tmp/treadle.apk
# 24.10:
# opkg install --force-reinstall /tmp/treadle.ipk
```

Reinstalling restores the shipped default `/etc/config/treadle` (it is a
conffile, so the package only writes it back when it is absent).

## Contributing

Build instructions, CI layout, and developer conventions live in
[`CONTRIBUTING.md`](CONTRIBUTING.md); how Treadle works and why is in
[`docs/design.md`](docs/design.md).

## License

GPL-3.0-only — see [`LICENSE`](LICENSE) for the full text.

The packaged `.apk` / `.ipk` runs a comment-stripping pass over the
source on its way into the install tree, so the on-router copy is
about half the size of the repo source. The `SPDX-License-Identifier`
and `Copyright` headers are preserved on every installed file, and the
package's `license:` metadata field records `GPL-3.0-only`. The repo
source is the canonical, fully-commented form — clone the repo to read
the code with its design notes intact.
