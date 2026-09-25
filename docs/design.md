# Design

How Treadle turns router settings into a running sing-box, and why the
pieces are shaped the way they are. For building, testing and conventions
see [CONTRIBUTING.md](../CONTRIBUTING.md); for version numbers see
[versioning.md](versioning.md).

## Moving parts

| Piece | Where | Role |
|---|---|---|
| LuCI views | `htdocs/…/view/treadle/` | One menu entry (`main.js`) hosting a tab per panel. Reads and writes UCI through LuCI's form layer; everything else goes through the rpcd handler. |
| rpcd handler | `usr/libexec/rpcd/luci.treadle` | The UI's backend: status, subscription sync, config preview, logs, latency tests. Runs as root, one process per call. |
| `build-config` | `usr/libexec/treadle/` | Translates UCI plus subscription node files into a sing-box JSON config, shaped for the installed sing-box version. The only writer of that config. |
| `run-singbox` | `usr/libexec/treadle/` | What procd runs: rebuilds the config first if it was built for another sing-box version, then execs sing-box. |
| Init script | `etc/init.d/treadle` | procd service: builds, validates and swaps the config, starts sing-box, applies the firewall and DNS handover. |
| `firewall.sh` | `usr/libexec/treadle/` | The `inet treadle` nftables table and the policy rule for TPROXY. |
| Cron jobs | `hourly`, `watchdog` | Subscription auto-update and scheduled latency tests; restart a service procd gave up on. |
| `active-watch` | `usr/libexec/treadle/` | Daemon (only with the clash API on) that snapshots group state and traffic every 10 s for the Status page and logs group switches. |

## Where state lives

- **UCI, `/etc/config/treadle`** — every setting. Fixed sections (`global`,
  `basic`, `inbounds`, `dns`, `routing`) plus named sections for
  subscriptions, manual nodes, rules, conditions, bypasses and custom
  rule-sets.
- **`/etc/treadle/nodes/<uid>.json`** — one file per subscription with its
  parsed nodes. Subscriptions can carry hundreds of nodes, which is the
  wrong shape for UCI.
- **`/etc/treadle/extra.json`** — an optional JSON object shallow-merged
  over the generated config in Advanced mode, for sing-box settings the UI
  does not expose. Written with mode 0600: it may hold credentials.
- **tmpfs, `/var/etc/treadle/`** — the generated config and everything
  derived at runtime (latency cache, status snapshots, the DNS drop-in).
  A reboot rebuilds all of it from the two sources above.

### Section identity

Every non-fixed section is a *named* UCI section whose name is a random
16-hex-character id, minted when it is created (`uid.js` in the UI;
the handler renames any `cfgXXXX` section added by hand). That name is
the only id: node files, rule → condition links, a node's subscription and
regex-group source filters all refer to it. There is no separate id option
to keep in step, and libuci's positional `cfgXXXX` names — which shift
when other sections are deleted — never reach anything persistent.

## From settings to a running sing-box

On every start and reload the init script:

1. builds the config to `<config_path>.next` with `build-config`;
2. validates it with `sing-box check`;
3. only if both succeed, moves it over the running config; procd restarts
   sing-box when the file changes and leaves it alone when it does not.

A build that fails or is rejected leaves sing-box running on the last
working config and logs why.

The config is shaped for the sing-box version installed when it was built.
A field the newer releases replace is emitted in the form that version
expects, and the version is recorded beside the config. procd restarts
sing-box on its own after a crash without rebuilding, so it starts it through
`run-singbox`, which rebuilds first when the installed version no longer
matches. A sing-box upgrade therefore never starts on a config built for the
old one. The running config lives on tmpfs, so a
config that only breaks after a reboot cannot survive one.

Starts are serialised by a lock. A start that finds it held waits for it
(bounded at 30 s) rather than giving up, because the running start may
have read the settings before the change that triggered the new one.

`build-config` emits only what the routing actually references — the
final outbound, each enabled rule's outbound, and the members of any group
among them — so a subscription with hundreds of nodes does not put
hundreds of outbounds in the running config. Groups can select members by
tag with a POSIX extended regular expression (evaluated with `grep -E`),
optionally limited to chosen subscriptions.

Subscription payloads are untrusted. The parsers accept share-link lists
(plain or base64), Clash YAML and sing-box JSON; `build-config` then copies
only an allow-listed set of fields per protocol into the config, drops
nodes whose transport sing-box cannot dial, and removes uTLS from
QUIC-carried protocols, where sing-box cannot use it.

### Basic and Advanced mode

Basic mode builds a small config from subscriptions only: the chosen
servers (wrapped in an automatic latency-based group when there are
several), an optional "bypass one country" rule, and a port filter. Manual
nodes, rules and `extra.json` stay on disk but are not compiled in, so
switching modes never loses settings.

## Getting traffic into sing-box

`inbounds.mode` picks the method:

- **`tproxy`** (default) and **`tproxy_mixed`** — `firewall.sh` installs
  `inet treadle`: a prerouting chain that TPROXYs LAN TCP and UDP to
  sing-box, skipping reserved ranges and per-device bypasses, and
  optionally an output chain for the router's own traffic. sing-box marks
  its own sockets (`default_mark`) so they are never looped back in.
- **`tun`** — sing-box routes through a TUN device itself; no firewall
  table is installed.
- **`mixed`** — a local SOCKS/HTTP proxy only.

On every reload the ruleset is **replaced atomically**: the generated
file declares, deletes and redefines the table, and one `nft -f` applies
that as a single transaction. Deleting the table first and loading the
new one after would let LAN traffic out unproxied for the moment in
between, and connections opened then would stay unproxied. The policy
rule that delivers marked packets to sing-box is added only when missing,
for the same reason.

### DNS handover

With managed DNS on, a dnsmasq drop-in makes sing-box dnsmasq's only
upstream (`no-resolv`, `server=127.0.0.1#5335`), while dnsmasq keeps
answering private and reserved zones itself so they cannot loop. There is
no fallback to the ISP resolvers: on networks where those answers are
tampered with, a wrong answer is worse than none. The drop-in is installed
only when the firewall setup succeeded and removed on stop, so dnsmasq is
never pointed at a sing-box that is not receiving traffic.

sing-box then picks the resolver per query from the routing rules:
domains routed through a proxy are resolved remotely through that same
outbound, the rest locally.

## Rule-sets

Routing conditions can use sing-box binary rule-sets (geosite / geoip
from the SagerNet, MetaCubeX or Loyalsoldier collections, or custom
URLs), downloaded by sing-box from GitHub or through jsDelivr. sing-box
caches them in `/etc/treadle/cache.db`, so after one successful download
it starts without network access. The UI's list of available names comes
from a separately cached catalog.

## Latency tests

Testing needs every known node dialable, but the running config holds
only the referenced ones. The test runner therefore builds a separate
probe config (`build-config --probe`: every node, a loopback clash API on
`127.0.0.1:9091`, nothing else), starts a short-lived second sing-box
from it, probes each node through that API in batches, and stops it. The
probe instance uses the same socket mark as the main one, so probes go
out directly instead of through the running proxy.

## The clash API

Off by default. When enabled, sing-box's clash-compatible API listens on
`127.0.0.1:9090` without a secret: anything that can reach a loopback port
on the router is already root there and can read the settings directly,
so a secret would protect nothing. It feeds `active-watch` and the Status
page's group and traffic panels.

## The Status page's polling cost

rpcd starts a new Lua process for every call, and reading the syslog
means dumping its whole ring buffer. The Status page therefore fetches
status, groups and traffic in a single call every 2 s, and the log tails
every 10 s (and right after a start, stop or toggle).
