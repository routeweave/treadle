// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Status tab: the dashboard. Answers "is it working?" at a glance and "why
// not?" without leaving the page.
//
// Layout (top → bottom):
//   warnings (sing-box too old for something configured, standalone service)
//   get started (only while nothing is configured)
//   banner (only while the connectivity check is failing)
//   service card — state + uptime, default-node switcher and the node in
//     use, Start/Stop/Restart, live traffic tiles, the Enable toggle
//   health — connectivity, DNS, subscriptions
//   nodes in use — everything traffic can go through and what uses it;
//     groups expand to their members
//   activity — Treadle events or the sing-box log, optionally warnings only
//   footer — versions, inbound mode, counts, generated config
//
// Two distinct controls for the service, as before:
//   * Enable (persistent, UCI global.enabled) — installed-but-dormant vs.
//     installed-and-running. Off hides everything that describes a running
//     service; the service won't autostart and the watchdog stays idle.
//   * Stop / Start / Restart (transient, tmpfs marker) — diagnostic
//     pause/resume/cycle without flipping the persistent flag. Reboot
//     clears the marker, so an enabled-but-paused service resumes.
//
// One 2 s poller drives the whole page through one batched RPC
// (get_dashboard); the log tail rides along on every LOG_EVERY-th tick. The
// card's top row is built once and updated in place, so the default-node
// dropdown is never rebuilt under the user's pointer; the other sections are
// rebuilt only when what they show changed.

'use strict';
'require baseclass';
'require rpc';
'require ui';
'require dom';
'require uci';
'require session';
'require view.treadle.lib.subs as subs';
'require view.treadle.lib.badges as badges';

// Everything a poll tick needs, from one handler process:
//   status — enabled / running / paused / version / mode, plus
//            package_version only when `versions` is passed (page load):
//            it changes only on an upgrade, and reading it scans the
//            package database
//   groups — each urltest group's active member (clash `now`) from the
//            snapshot the active-watch daemon writes every 10 s, the same
//            view that backs the syslog change-log; { error: "clash API
//            disabled", groups: [] } when the feature is off
//   stats  — live throughput, session totals, connection count and (when
//            sing-box exposes it) clash-runtime memory, from the same
//            daemon's /connections snapshot; { error: … } when off
//   logs   — { treadle: [...], singbox: [...] }, only when `logs` (the
//            tail length) is passed, because reading syslog is the
//            expensive part
var callGetDashboard = rpc.declare({
	object: 'luci.treadle',
	method: 'get_dashboard',
	params: ['logs', 'versions'],
	expect: { '': {} }
});

var callSetEnabled = rpc.declare({
	object: 'luci.treadle',
	method: 'set_enabled',
	params: [ 'enabled' ],
	expect: { '': {} }
});

var callStart = rpc.declare({
	object: 'luci.treadle',
	method: 'start',
	expect: { '': {} }
});

var callStop = rpc.declare({
	object: 'luci.treadle',
	method: 'stop',
	expect: { '': {} }
});

var callRestart = rpc.declare({
	object: 'luci.treadle',
	method: 'restart',
	expect: { '': {} }
});

var callGetLog = rpc.declare({
	object: 'luci.treadle',
	method: 'get_log',
	params: ['lines'],
	expect: { '': {} }
});

var callGetConfig = rpc.declare({
	object: 'luci.treadle',
	method: 'get_config',
	expect: { '': {} }
});

var callListOutbounds = rpc.declare({
	object: 'luci.treadle',
	method: 'list_outbounds',
	expect: { '': {} }
});

var TAIL_LINES     = 30;    // fetched, so the warnings filter has lines to pick from
var SHOW_LINES     = 8;     // shown in the Activity panel
var POLL_MS        = 2000;
var LOG_EVERY      = 5;     // log tails on every 5th tick (10 s)
var FULL_LOG_LINES = 500;

// Strip the syslog wrapper, sing-box's redundant inner UTC timestamp, and the
// ANSI color escapes from a single log line. The on-disk format is
//   "Sun May 24 08:34:01 2026 daemon.err sing-box[9596]: +0000 2026-05-24 ...
//    \x1b[31mERROR\x1b[0m [\x1b[38;5;226m6532...\x1b[0m 5.0s] <msg>"
// — half the row is timestamps and ANSI noise. We compress to a single
// "YYYY/MM/DD HH:MM:SS <message>" so the message itself fits the visible
// width of the log box without horizontal scrolling for every line.
var MONTHS = {
	Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
	Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
};
// syslog ts (Mon Day HH:MM:SS Year), then "daemon.<sev> <tag>[<pid>]:",
// then sing-box's own optional "+TZ YYYY-MM-DD HH:MM:SS " prefix, then msg.
var LOG_RE = /^\w{3} (\w{3})\s+(\d+) (\d{2}:\d{2}:\d{2}) (\d{4}) \S+ \S+:\s*(?:[+-]\d{4}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+)?(.*)$/;
var ANSI_RE = /\x1b\[[0-9;]*m/g;

function cleanLogLine(line) {
	var s = String(line).replace(ANSI_RE, '');
	var m = s.match(LOG_RE);
	if (!m) return s;
	var mm = MONTHS[m[1]] || '00';
	var dd = (m[2].length < 2 ? '0' : '') + m[2];
	return m[4] + '/' + mm + '/' + dd + ' ' + m[3] + ' ' + m[5];
}

function formatLog(lines) {
	if (!Array.isArray(lines)) return '';
	return lines.map(cleanLogLine).join('\n');
}

// "sing-box version 1.12.17" → "sing-box 1.12.17" (drop the redundant
// "version" word) so the footer template doesn't render "sing-box sing-box ".
function shortVersion(v) {
	if (!v) return _('unknown version');
	return String(v).replace(/^sing-box version\s+/, 'sing-box ');
}

// Compact byte formatting for cumulative totals — binary units (1024)
// because the clash counters are byte counts and the rest of the OpenWrt
// UI uses binary too (status overview, interface stats). Picks the unit
// that fits in three significant digits.
function formatBytes(n) {
	n = Number(n) || 0;
	if (n < 1024) return n + ' B';
	var units = [ 'KiB', 'MiB', 'GiB', 'TiB' ];
	var v = n / 1024;
	for (var i = 0; i < units.length; i++) {
		if (v < 1024 || i === units.length - 1) {
			return (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v))
				+ ' ' + units[i];
		}
		v /= 1024;
	}
}

// Same shape as formatBytes but with a /s suffix. The daemon writes
// integer bytes/sec so we round to whole units in the smallest band.
function formatRate(bps) {
	bps = Number(bps) || 0;
	if (bps <= 0) return '0 B/s';
	return formatBytes(bps) + '/s';
}

// Active outbound for the runtime header, from treadle.routing.final_outbound.
function runtimeInfo() {
	var tag = uci.get('treadle', 'routing', 'final_outbound') || '';

	var ruleCount = uci.sections('treadle', 'rule').filter(function(r) {
		return r.enabled !== '0';
	}).length;

	return {
		tag:       tag,
		ruleCount: ruleCount
	};
}

// Trigger a browser download of the given JSON text as sing-box.json. Uses a
// Blob URL rather than a data: URL — large configs would otherwise blow past
// the data-URL length limit some browsers still enforce.
// Warning for what the last build left out because the installed sing-box
// cannot run it (get_status `compat`, from build-config). Each feature key
// names what to upgrade; an unknown key still gets a generic line.
function renderCompat(compat) {
	if (!Array.isArray(compat) || !compat.length)
		return [];
	var msgs = {
		ech: _('ECH needs a sing-box built with Go 1.24 or later, as in OpenWrt 25.12. The installed one is older, so these nodes are left out: %s'),
		tun_mac: _('MAC bypass in TUN mode needs sing-box 1.14 or later. The installed one is older, so these clients still go through Treadle: %s'),
		dns_optimistic: _('The optimistic DNS cache needs sing-box 1.14 or later. The installed one is older, so it is off.')
	};
	return [ E('div', { 'class': 'alert-message warning' }, compat.map(function(c) {
		var items = Array.isArray(c.items) ? c.items.join(', ') : '';
		return E('p', {}, [ msgs[c.key]
			? msgs[c.key].format(items)
			: _('The installed sing-box cannot run %s, so these are left out: %s').format(c.key, items) ]);
	})) ];
}

// Warning while the sing-box package's own service is enabled (get_status
// `standalone_singbox`). Treadle runs its own instance and never uses it;
// SagerNet's package ships it enabled, running a demo Shadowsocks server.
function renderStandalone(on) {
	if (!on)
		return [];
	return [ E('div', { 'class': 'alert-message warning' }, [
		E('p', {}, [ _('The sing-box package\'s own service is enabled (/etc/config/sing-box). Treadle runs its own sing-box and does not use it; a second instance can conflict with Treadle, and SagerNet\'s package enables it with a demo Shadowsocks server. Unless you set it up yourself, disable it: uci set sing-box.main.enabled=0; uci commit sing-box; /etc/init.d/sing-box stop') ])
	]) ];
}

function renderWarnings(status) {
	return renderCompat(status.compat).concat(renderStandalone(status.standalone_singbox));
}

function downloadConfig(json) {
	var blob = new Blob([ json ], { type: 'application/json' });
	var url  = URL.createObjectURL(blob);
	var a    = document.createElement('a');
	a.href     = url;
	a.download = 'sing-box.json';
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	// Defer revocation a frame so Safari has time to dispatch the download
	// before the URL becomes invalid.
	requestAnimationFrame(function() { URL.revokeObjectURL(url); });
}

// Colours for the health dots. The badges reuse LuCI's label classes; these
// small dots have no class of their own, so they take literal colours that
// read on both the light and the dark themes.
var DOT = {
	ok:   '#26a65b',
	warn: '#e0a43a',
	bad:  '#dc3545',
	off:  'rgba(128,128,128,0.6)'
};

// Same red as lib/badges.js: Bootstrap has no red label class.
var DANGER_STYLE =
	' background-color: var(--danger-color, var(--error-color, var(--error-color-high, #d9534f)));' +
	' color: var(--on-danger-color, var(--on-error-color, #fff));';

// Page-scoped styles. Small and structural: the grids that let the tiles,
// health cards and member lists wrap to one column on a phone.
var STATUS_CSS =
	'.treadle-status .treadle-row{display:flex;flex-wrap:wrap;align-items:center;gap:.5em 1em}' +
	'.treadle-status .treadle-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9em,1fr));gap:.6em;margin-top:.9em}' +
	'.treadle-status .treadle-tile{background:rgba(128,128,128,.08);border-radius:6px;padding:.55em .8em}' +
	'.treadle-status .treadle-tile small{display:block;opacity:.7;font-size:.8em}' +
	'.treadle-status .treadle-tile strong{font-size:1.2em;font-variant-numeric:tabular-nums}' +
	'.treadle-status .treadle-health{display:grid;grid-template-columns:repeat(auto-fit,minmax(15em,1fr));gap:.8em;margin:1.2em 0}' +
	'.treadle-status .treadle-hcard{border:1px solid rgba(128,128,128,.3);border-radius:6px;padding:.7em .9em}' +
	'.treadle-status .treadle-hcard small{opacity:.75}' +
	'.treadle-status .treadle-dot{display:inline-block;width:.6em;height:.6em;border-radius:50%;margin-right:.45em;vertical-align:middle}' +
	'.treadle-status .treadle-muted{opacity:.7}' +
	'.treadle-status .treadle-members{display:flex;flex-wrap:wrap;gap:.45em;padding:.3em 0 .5em}' +
	'.treadle-status .treadle-chip{display:inline-flex;align-items:center;gap:.55em;padding:.25em .35em .25em .65em;border:1px solid rgba(128,128,128,.4);border-radius:5px;white-space:nowrap}' +
	'.treadle-status .treadle-chip-on{border:2px solid ' + DOT.ok + ';font-weight:bold}' +
	'.treadle-status .treadle-toggle{padding:0 .5em;min-width:2.4em;font-size:1.1em;line-height:1.6}' +
	'.treadle-status .treadle-show-narrow{display:none}' +
	'.treadle-status .treadle-log{font-family:monospace;font-size:.85em;max-height:16em;overflow-y:auto}' +
	'.treadle-status .treadle-log > div{display:flex;gap:.8em;padding:.15em 0;white-space:nowrap;align-items:baseline}' +
	'.treadle-status .treadle-log .treadle-msg{overflow:hidden;text-overflow:ellipsis}' +
	'@media (max-width:600px){.treadle-status .treadle-hide-narrow{display:none}' +
	'.treadle-status .treadle-show-narrow{display:block;font-size:.85em}}';

// "93 s" / "12 min" / "5 h" / "9 d": an age in seconds, coarse on purpose.
function formatAge(s) {
	s = Number(s);
	if (!(s >= 0)) return '';
	if (s < 60)    return _('%d s').format(s);
	if (s < 3600)  return _('%d min').format(Math.floor(s / 60));
	if (s < 86400) return _('%d h').format(Math.floor(s / 3600));
	return _('%d d').format(Math.floor(s / 86400));
}

function formatUptime(s) {
	s = Number(s) || 0;
	var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
	if (d > 0) return _('%d d %d h').format(d, h);
	if (h > 0) return _('%d h %d min').format(h, m);
	return _('%d min').format(m);
}

// Severity of one raw syslog line: 'error', 'warning' or 'info'. sing-box
// writes every line to stderr, so its own level token decides; Treadle's
// lines carry it in the syslog priority (daemon.err, daemon.warning, …).
function lineLevel(line) {
	var s = String(line).replace(ANSI_RE, '');
	var tok = s.match(/\b(FATAL|PANIC|ERROR|WARN|INFO|DEBUG|TRACE)\[/);
	if (tok) {
		if (tok[1] === 'WARN') return 'warning';
		if (tok[1] === 'INFO' || tok[1] === 'DEBUG' || tok[1] === 'TRACE') return 'info';
		return 'error';
	}
	var pri = s.match(/ daemon\.(\w+) /);
	if (pri) {
		if (/^(emerg|alert|crit|err)$/.test(pri[1])) return 'error';
		if (pri[1] === 'warning' || pri[1] === 'warn') return 'warning';
	}
	return 'info';
}

// One log line as { time, level, msg }: the cleaned "YYYY/MM/DD HH:MM:SS
// msg" form cut to the time of day, with sing-box's "LEVEL[id] [conn dur]"
// prefix dropped — the level is shown as a badge, and the connection id
// means nothing at a glance.
function parseLogLine(line) {
	var clean = cleanLogLine(line);
	var m = clean.match(/^\d{4}\/\d{2}\/\d{2} (\d{2}:\d{2}:\d{2}) (.*)$/);
	var msg = m ? m[2] : clean;
	msg = msg.replace(/^(FATAL|PANIC|ERROR|WARN|INFO|DEBUG|TRACE)\[\d+\]\s*(\[[^\]]*\]\s*)?/, '');
	return { time: m ? m[1] : '', level: lineLevel(line), msg: msg };
}

// "DoH" / "DoT" / "DoQ" / "plain DNS" for a resolver address as Settings
// stores it.
function resolverKind(addr) {
	addr = String(addr || '');
	if (/^https:\/\//.test(addr)) return _('DoH');
	if (/^h3:\/\//.test(addr))    return _('DoH3');
	if (/^tls:\/\//.test(addr))   return _('DoT');
	if (/^quic:\/\//.test(addr))  return _('DoQ');
	return _('plain DNS');
}

// A group's members for display: the one in use first, then the fastest,
// then the ones without a result. Stable within each band, so equal
// latencies keep the group's own order. Shown sorted, the chips answer "why
// is it on this node?" at a glance next to the group's tolerance.
function sortMembers(members, now) {
	return arr(members).map(function(m, i) {
		return { m: m, i: i };
	}).sort(function(a, b) {
		var ra = a.m.tag === now ? 0 : (a.m.delay_ms ? 1 : 2);
		var rb = b.m.tag === now ? 0 : (b.m.delay_ms ? 1 : 2);
		if (ra !== rb) return ra - rb;
		if (ra === 1 && a.m.delay_ms !== b.m.delay_ms) return a.m.delay_ms - b.m.delay_ms;
		return a.i - b.i;
	}).map(function(x) { return x.m; });
}

// luci.jsonc sends an empty Lua table as {}; every list from the router goes
// through this before .forEach.
function arr(v) {
	return Array.isArray(v) ? v : [];
}

return baseclass.extend({
	_statusTimer: null,
	_onVisible: null,
	_packageVersion: null,
	_tick: 0,

	load: function() {
		// All RPCs degrade gracefully — a missing one leaves the relevant
		// section blank rather than blanking the tab.
		return Promise.all([
			callGetDashboard(TAIL_LINES, true).catch(function() { return {}; }),
			callListOutbounds().catch(function() { return {}; }),
			uci.load('treadle').catch(function() { return null; })
		]).then(function(r) {
			return { dash: r[0] || {}, outbounds: arr((r[1] || {}).outbounds) };
		});
	},

	render: function(data) {
		data = data || {};
		var d = data.dash || {};
		var status = d.status || {};
		var self = this;

		// Snapshots for the whole page life: the node list feeds the
		// default-node switcher and the "Kind" column; adding a node means
		// leaving this tab, which re-renders it.
		this._outbounds = data.outbounds || [];
		this._packageVersion = status.package_version;
		this._logs = d.logs || {};
		this._sigs = {};
		this._open = session.getLocalData('treadle.statusOpen') || {};
		this._logSrc = session.getLocalData('treadle.statusLog') || 'treadle';
		this._warnOnly = !!session.getLocalData('treadle.statusWarnOnly');

		var subCount = uci.sections('treadle', 'subscription').length;
		var manualCount = uci.sections('treadle', 'node').length;
		var els = this._els = {};

		els.compat  = E('div', {}, renderWarnings(status));
		els.banner  = E('div', {});
		els.badge   = E('span', { 'id': 'treadle-status-badge' });
		els.uptime  = E('span', { 'class': 'treadle-muted' });
		els.using   = E('span', { 'class': 'treadle-muted' });
		els.actions = E('span', { 'style': 'margin-left:auto; display:flex; gap:0.3em;' });
		els.pause   = E('div', { 'class': 'treadle-muted', 'style': 'margin-top:0.4em; display:none;' },
			[ _('Paused for testing — will resume on next reboot.') ]);
		els.tiles   = E('div', {});
		els.enable  = E('div', { 'class': 'treadle-row', 'style': 'margin-top:0.9em;' },
			this._renderEnable(status.enabled));
		els.running = E('div', {}, [
			E('div', { 'class': 'treadle-row' }, [
				els.badge, els.uptime,
				E('label', { 'for': 'treadle-default-node', 'class': 'treadle-muted' }, [ _('Default node') ]),
				this._renderNodeSwitcher(uci.get('treadle', 'routing', 'final_outbound') || ''),
				els.using,
				els.actions
			]),
			els.pause,
			els.tiles
		]);
		els.health  = E('div', { 'class': 'treadle-health' });
		els.inuse   = E('div', { 'class': 'cbi-section' });
		els.log     = E('div', { 'class': 'treadle-log' });
		els.logBar  = E('div', { 'class': 'treadle-row', 'style': 'margin-bottom:0.5em;' });
		els.footer  = E('div', { 'class': 'treadle-row treadle-muted', 'style': 'font-size:0.9em; margin:0.5em 0 2em;' });

		var node = E('div', { 'class': 'cbi-map treadle-status' }, [
			E('style', {}, [ STATUS_CSS ]),
			els.compat,
			// First-run checklist, shown only while nothing at all is
			// configured. Static per render: adding a node happens on another
			// tab, and returning here re-renders the panel.
			(subCount === 0 && manualCount === 0 && this._outbounds.length === 0)
				? this._renderGetStarted()
				: '',
			els.banner,
			E('div', { 'class': 'cbi-section' }, [ els.running, els.enable ]),
			els.health,
			els.inuse,
			E('div', { 'class': 'cbi-section' }, [ els.logBar, els.log ]),
			els.footer
		]);

		this._apply(d, true);

		// Polling has to wait until the panel's DOM is attached: render()
		// builds a detached node and the host shell (main.js) appends it in a
		// .then microtask after we return. requestAnimationFrame fires after
		// that microtask, so _scheduleStatusRefresh's "is the panel mounted?"
		// guard can see the badge by then.
		requestAnimationFrame(L.bind(function() {
			this._scheduleStatusRefresh();
		}, this));

		self._renderLogBar();
		return node;
	},

	// ── Renderers ─────────────────────────────────────────────────────────

	// Three runtime states: 'running' (sing-box up), 'paused' (user clicked
	// Stop, marker present), 'stopped' (down without a marker — typically
	// a crash that exhausted procd respawn before the watchdog re-armed).
	_runtimeState: function(status) {
		if (status.running) return 'running';
		if (status.paused)  return 'paused';
		return 'stopped';
	},

	_renderBadge: function(state, enabled) {
		var base = 'padding:0.25em 0.8em; border-radius:999px; font-size:1.05em; text-transform:none;';
		if (!enabled)
			return E('span', { 'class': 'label', 'style': base }, [ _('Off') ]);
		if (state === 'running')
			return E('span', { 'class': 'label success', 'style': base }, [ _('Running') ]);
		if (state === 'paused')
			return E('span', { 'class': 'label warning', 'style': base }, [ _('Paused') ]);
		return E('span', { 'class': 'label', 'style': base + DANGER_STYLE }, [ _('Stopped') ]);
	},

	_renderEnable: function(enabled) {
		// "applies immediately" because this toggle commits through rpcd on
		// click — unlike everything else in Treadle, there is no Save & Apply
		// step between the click and the service action.
		var cb = E('input', {
			'type': 'checkbox',
			'id': 'treadle-enable-checkbox',
			'class': 'cbi-input-checkbox',
			'style': 'margin:0;',
			'click': ui.createHandlerFn(this, 'handleToggleEnabled')
		});
		if (enabled) cb.checked = true;
		return [
			cb,
			E('label', { 'for': 'treadle-enable-checkbox', 'style': 'margin:0; cursor:pointer;' }, [ _('Enable Treadle') ]),
			E('span', { 'class': 'treadle-muted', 'style': 'font-size:0.9em;' }, [
				enabled
					? _('sing-box runs and starts at boot · applies immediately')
					: _('installed but dormant: no service, no autostart · applies immediately')
			])
		];
	},

	_tile: function(label, value, unit) {
		return E('div', { 'class': 'treadle-tile' }, [
			E('small', {}, [ label ]),
			E('strong', {}, [ value ]),
			unit ? E('span', { 'class': 'treadle-muted' }, [ ' ', unit ]) : ''
		]);
	},

	// Five live numbers from active-watch's /connections snapshot, or a
	// pointer to Settings when the clash API they come from is off.
	_renderTiles: function(stats) {
		if (stats.error)
			return [ E('div', { 'class': 'treadle-muted', 'style': 'margin-top:0.9em;' }, [
				_('Live stats are off. Turn on "Live stats and latency testing" on the '),
				this._tabLink('settings', _('Settings')),
				_(' tab to see traffic, the nodes in use and the connectivity check.')
			]) ];
		var tiles = [
			this._tile(_('Download'), formatRate(stats.down_bps)),
			this._tile(_('Upload'), formatRate(stats.up_bps)),
			this._tile(_('Connections'), String(stats.conn_count || 0)),
			this._tile(_('This session'), formatBytes(stats.total_down) + ' ↓ ' + formatBytes(stats.total_up) + ' ↑')
		];
		if (typeof stats.mem_inuse === 'number' && stats.mem_inuse > 0)
			tiles.push(this._tile(_('sing-box memory'), formatBytes(stats.mem_inuse)));
		return [ E('div', { 'class': 'treadle-tiles' }, tiles) ];
	},

	// ── Health ────────────────────────────────────────────────────────────

	// The connectivity check from active-watch: one test a minute through
	// whatever the default node resolves to.
	_connectivityHealth: function(g, running) {
		var c = g.connectivity;
		var now = Number(g.now) || 0;
		if (g.error)
			return { state: 'off', value: _('Off'), sub: _('Needs live stats (Settings)') };
		if (!running)
			return { state: 'off', value: _('Not running'), sub: '' };
		if (!c)
			return { state: 'off', value: _('Waiting'), sub: _('The first check runs within a minute') };
		if (c.state === 'none')
			return { state: 'off', value: _('Not checked'), sub: _('The default node is not a proxy') };
		var ago = (c.checked_at && now) ? formatAge(now - c.checked_at) : '';
		if (c.state === 'ok')
			return { state: 'ok', value: _('OK · %d ms').format(c.delay_ms),
				sub: _('Through %s, checked %s ago').format(c.via, ago) };
		if (c.state === 'failing')
			return { state: 'bad', value: _('Failing'),
				sub: _('%d checks in a row through %s').format(c.streak, c.via) };
		return { state: 'warn', value: _('Retrying'),
			sub: _('The last check through %s failed').format(c.via) };
	},

	_dnsHealth: function() {
		var managed = uci.get('treadle', 'dns', 'managed_dns') !== '0';
		var remote = uci.get('treadle', 'dns', 'remote_server') || 'tls://1.1.1.1';
		var local = uci.get('treadle', 'dns', 'local_server') || 'wan';
		return {
			state: managed ? 'ok' : 'off',
			value: managed ? _('Managed') : _('Not managed'),
			sub: _('Remote: %s · Local: %s').format(resolverKind(remote),
				local === 'wan' ? _('WAN resolver') : resolverKind(local))
		};
	},

	// Stale: the last sync failed, or it is older than twice the subscription's
	// own auto-update interval, or older than a week when auto-update is off.
	_subscriptionHealth: function(ages) {
		// Since the last sync that brought nodes in: a failed attempt does
		// not make a subscription fresh.
		var ageOf = {};
		arr(ages).forEach(function(a) { ageOf[a.id] = (a.ok_age_s != null) ? a.ok_age_s : a.age_s; });
		var list = uci.sections('treadle', 'subscription');
		if (!list.length)
			return { state: 'off', value: _('None'), sub: _('Add one on the Nodes tab') };
		var stale = [], newest = null;
		list.forEach(function(s) {
			var age = ageOf[s['.name']];
			var hours = Number(s.auto_update) || 0;
			var limit = hours > 0 ? 2 * hours * 3600 : 7 * 86400;
			if (typeof age === 'number' && (newest === null || age < newest)) newest = age;
			var failed = (s.status && s.status !== 'ok') || !!s.sync_error;
			if (failed || typeof age !== 'number' || age > limit)
				stale.push({ name: s.name || s['.name'], age: age, failed: failed, why: s.sync_error });
		});
		if (stale.length) {
			var first = stale[0];
			return {
				state: 'warn',
				value: _('%d of %d stale').format(stale.length, list.length),
				sub: first.failed
					? (first.why ? _('%s: %s').format(first.name, first.why) : _('%s: last sync failed').format(first.name))
					: (typeof first.age === 'number'
						? _('%s: last synced %s ago').format(first.name, formatAge(first.age))
						: _('%s: never synced').format(first.name))
			};
		}
		return { state: 'ok', value: _('%d up to date').format(list.length),
			sub: newest !== null ? _('Last sync %s ago').format(formatAge(newest)) : '' };
	},

	_renderHealth: function(items) {
		return items.map(function(h) {
			return E('div', {
				'class': 'treadle-hcard',
				'style': h.state === 'bad' ? 'border-color:' + DOT.bad + ';'
					: h.state === 'warn' ? 'border-color:' + DOT.warn + ';' : ''
			}, [
				E('div', { 'class': 'treadle-muted', 'style': 'font-size:0.8em; text-transform:uppercase; letter-spacing:0.05em;' }, [
					E('span', { 'class': 'treadle-dot', 'style': 'background:' + DOT[h.state] + ';' }),
					h.label
				]),
				E('div', { 'style': 'font-weight:bold; margin:0.25em 0 0.15em;' }, [ h.value ]),
				E('small', {}, [ h.sub ])
			]);
		});
	},

	// Red banner while the connectivity check is failing: the one state the
	// rest of the page cannot make obvious on its own.
	_renderBanner: function(g, running) {
		var c = g.connectivity;
		if (!running || g.error || !c || c.state !== 'failing')
			return [];
		var now = Number(g.now) || 0;
		var since = (c.last_ok_at && now)
			? _('Last success %s ago.').format(formatAge(now - c.last_ok_at))
			: _('No check has succeeded since sing-box started.');
		return [ E('div', { 'class': 'alert-message danger' }, [
			E('strong', {}, [ _('Traffic through %s is failing').format(c.default) ]),
			E('p', { 'style': 'margin:0.3em 0 0;' }, [
				_('The last %d connectivity checks through %s failed.').format(c.streak, c.via), ' ',
				since, ' ',
				_('sing-box is running, so the node or its provider is not answering. A group moves off a failed member by itself; check the members below or the nodes on the '),
				this._tabLink('nodes', _('Nodes')),
				_(' tab.')
			])
		]) ];
	},

	// ── Nodes in use ──────────────────────────────────────────────────────

	// Everything traffic can go through and what uses it: the default node
	// and each enabled rule's node, merged per node, then any other group in
	// the running config. "direct" and "block" are not nodes and are left
	// out.
	_inUseRows: function(g) {
		var groups = arr(g.groups), nodes = arr(g.nodes);
		var groupOf = {}, nodeOf = {}, users = {}, order = [];
		groups.forEach(function(x) { groupOf[x.tag] = x; });
		nodes.forEach(function(x) { nodeOf[x.tag] = x; });
		var add = function(tag, user) {
			if (!tag || tag === 'direct' || tag === 'block') return;
			if (!users[tag]) { users[tag] = { isDefault: false, rules: [] }; order.push(tag); }
			if (user === null) users[tag].isDefault = true;
			else users[tag].rules.push(user);
		};
		add(uci.get('treadle', 'routing', 'final_outbound') || '', null);
		uci.sections('treadle', 'rule').filter(function(r) {
			return r.enabled !== '0';
		}).sort(function(a, b) {
			return (parseInt(a.order, 10) || 0) - (parseInt(b.order, 10) || 0);
		}).forEach(function(r) {
			add(r.outbound, r.name || _('unnamed rule'));
		});
		groups.forEach(function(x) { if (!users[x.tag]) { users[x.tag] = { isDefault: false, rules: [] }; order.push(x.tag); } });
		return order.map(function(tag) {
			var u = users[tag], parts = [];
			if (u.isDefault) parts.push(_('Default'));
			if (u.rules.length === 1) parts.push(_('Rule: %s').format(u.rules[0]));
			else if (u.rules.length > 1) parts.push(_('Rules: %s').format(u.rules.join(', ')));
			return { tag: tag, usedBy: parts.join(' · '), group: groupOf[tag], node: nodeOf[tag] };
		});
	},

	// "Node · manual" or "Node · <subscription>": where a single node comes from.
	_nodeKind: function(tag) {
		var manual = uci.sections('treadle', 'node').some(function(s) {
			return s.tag === tag && s.type !== 'urltest';
		});
		if (manual) return _('Node · manual');
		var subName = subs.nameMap();
		for (var i = 0; i < this._outbounds.length; i++)
			if (this._outbounds[i].tag === tag && this._outbounds[i].subscription)
				return _('Node · %s').format(subName[this._outbounds[i].subscription] || this._outbounds[i].subscription);
		return _('Node');
	},

	// A latency badge for one result: ms, "timeout" when tested without an
	// answer, "—" when not tested yet.
	_latency: function(ms, tested) {
		if (typeof ms === 'number' && ms > 0)
			return badges.formatLatency({ delay_ms: ms });
		if (tested)
			return badges.formatLatency({ error: _('timeout') });
		return badges.formatLatency(null);
	},

	_toggleOpen: function(tag) {
		this._open[tag] = !this._open[tag];
		session.setLocalData('treadle.statusOpen', this._open);
		this._sigs.inuse = null;
		this._renderInUse(this._lastGroups || {});
	},

	_renderInUse: function(g) {
		var self = this;
		var rows = this._inUseRows(g);
		var sig = JSON.stringify([ rows, this._open ]);
		if (sig === this._sigs.inuse) return;
		this._sigs.inuse = sig;

		if (g.error || !rows.length) {
			this._els.inuse.style.display = 'none';
			return;
		}
		this._els.inuse.style.display = '';

		var trs = [];
		rows.forEach(function(r) {
			var x = r.group, open = !!(x && self._open[r.tag]);
			var toggle = x ? E('button', {
				'class': 'btn cbi-button cbi-button-neutral treadle-toggle',
				'aria-expanded': open ? 'true' : 'false',
				'aria-label': (open ? _('Hide members of %s') : _('Show members of %s')).format(r.tag),
				'click': function() { self._toggleOpen(r.tag); }
			}, [ open ? '▾' : '▸' ]) : '';
			var kind = x
				? _('Group · %d nodes').format(arr(x.members).length)
				: self._nodeKind(r.tag);
			// On a phone the Used by and Kind columns are hidden and the same
			// text moves under the node name.
			var name = [
				E('strong', {}, [ r.tag ]),
				(x && x.now) ? E('span', { 'class': 'treadle-muted' }, [ '  →  ' + x.now ]) : '',
				r.usedBy ? E('span', { 'class': 'treadle-muted treadle-show-narrow' }, [ r.usedBy ]) : '',
				E('span', { 'class': 'treadle-muted treadle-show-narrow' }, [ kind ])
			];
			var latency = x
				? self._latency(x.delay_ms, !!x.now)
				: self._latency(r.node && r.node.delay_ms, !!(r.node && r.node.tested_at));
			// Node and latency side by side: "is the node I go through
			// healthy?" is the question this table answers first.
			trs.push(E('tr', { 'class': 'tr cbi-section-table-row' }, [
				E('td', { 'class': 'td', 'style': 'width:1%;' }, [ toggle ]),
				E('td', { 'class': 'td' }, name),
				E('td', { 'class': 'td' }, [ latency ]),
				E('td', { 'class': 'td treadle-hide-narrow' }, [ r.usedBy || E('span', { 'class': 'treadle-muted' }, [ _('inside another group') ]) ]),
				E('td', { 'class': 'td treadle-muted treadle-hide-narrow' }, [ kind ])
			]));
			if (open)
				trs.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td' }),
					E('td', { 'class': 'td', 'colspan': '4' }, [
						// One chip per member, name and latency together, so a
						// badge can never be read as the next member's. The
						// member in use is bold with a thicker border, so it
						// does not rely on its green alone.
						E('div', { 'class': 'treadle-members' }, sortMembers(x.members, x.now).map(function(m) {
							var inUse = (m.tag === x.now);
							return E('span', {
								'class': 'treadle-chip' + (inUse ? ' treadle-chip-on' : ''),
								'title': inUse ? _('%s: in use').format(m.tag) : m.tag
							}, [
								E('span', {}, [ m.tag ]),
								self._latency(m.delay_ms, true)
							]);
						})),
						E('div', { 'class': 'treadle-muted', 'style': 'font-size:0.85em;' }, [
							_('Uses the fastest member, and switches only when another is more than %s ms faster. Tested every %s.')
								.format(x.tolerance || '50', x.interval || '3m')
						])
					])
				]));
		});

		dom.content(this._els.inuse, [
			E('h3', {}, [ _('Nodes in use') ]),
			E('div', { 'class': 'cbi-section-descr' }, [ _('Everything your traffic can go through right now, and why.') ]),
			E('table', { 'class': 'table cbi-section-table' }, [
				E('thead', {}, [ E('tr', { 'class': 'tr cbi-section-table-titles' }, [
					E('th', { 'class': 'th' }),
					E('th', { 'class': 'th' }, [ _('Node') ]),
					E('th', { 'class': 'th' }, [ _('Latency') ]),
					E('th', { 'class': 'th treadle-hide-narrow' }, [ _('Used by') ]),
					E('th', { 'class': 'th treadle-hide-narrow' }, [ _('Kind') ])
				]) ]),
				E('tbody', {}, trs)
			])
		]);
	},

	// ── Activity ──────────────────────────────────────────────────────────

	_renderLogBar: function() {
		var self = this;
		var srcBtn = function(id, label) {
			return E('button', {
				'class': 'btn cbi-button ' + (self._logSrc === id ? 'cbi-button-apply' : 'cbi-button-neutral'),
				'aria-pressed': self._logSrc === id ? 'true' : 'false',
				'click': function() {
					self._logSrc = id;
					session.setLocalData('treadle.statusLog', id);
					self._renderLogBar();
					self._renderLog();
				}
			}, [ label ]);
		};
		var cb = E('input', {
			'type': 'checkbox', 'id': 'treadle-warn-only', 'class': 'cbi-input-checkbox', 'style': 'margin:0;',
			'change': function(ev) {
				self._warnOnly = ev.currentTarget.checked;
				session.setLocalData('treadle.statusWarnOnly', self._warnOnly);
				self._renderLog();
			}
		});
		if (this._warnOnly) cb.checked = true;
		dom.content(this._els.logBar, [
			E('h3', { 'style': 'margin:0;' }, [ _('Activity') ]),
			E('span', { 'style': 'display:inline-flex; gap:0.2em;', 'role': 'group', 'aria-label': _('Log source') }, [
				srcBtn('treadle', _('Treadle events')),
				srcBtn('singbox', _('sing-box'))
			]),
			E('span', { 'style': 'display:inline-flex; align-items:center; gap:0.4em;' }, [
				cb, E('label', { 'for': 'treadle-warn-only', 'style': 'margin:0;' }, [ _('Warnings and errors only') ])
			]),
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral', 'style': 'margin-left:auto;',
				'click': ui.createHandlerFn(this, '_showFullLog')
			}, [ _('Full log') ])
		]);
		this._renderLog();
	},

	_renderLog: function() {
		var self = this;
		var lines = arr(this._logs[this._logSrc]).map(parseLogLine).filter(function(l) {
			return !self._warnOnly || l.level !== 'info';
		}).slice(-SHOW_LINES);
		if (!lines.length) {
			dom.content(this._els.log, [ E('div', { 'class': 'treadle-muted', 'style': 'font-family:inherit;' }, [
				this._warnOnly ? _('No warnings or errors in the recent log.') : _('Nothing logged yet.')
			]) ]);
			return;
		}
		dom.content(this._els.log, lines.map(function(l) {
			var badge = l.level === 'error'
				? E('span', { 'class': 'label', 'style': 'text-transform:none; flex:0 0 auto;' + DANGER_STYLE }, [ _('error') ])
				: l.level === 'warning'
					? E('span', { 'class': 'label warning', 'style': 'text-transform:none; flex:0 0 auto;' }, [ _('warning') ])
					: E('span', { 'class': 'treadle-muted', 'style': 'flex:0 0 auto; min-width:4.5em;' }, [ _('info') ]);
			return E('div', {}, [
				E('span', { 'class': 'treadle-muted', 'style': 'flex:0 0 auto;' }, [ l.time ]),
				badge,
				E('span', { 'class': 'treadle-msg', 'title': l.msg }, [ l.msg ])
			]);
		}));
	},

	_renderFooter: function(status) {
		var parts = [];
		var pkg = status.package_version || this._packageVersion;
		if (pkg) parts.push('Treadle ' + pkg);
		parts.push(shortVersion(status.version));
		parts.push((uci.get('treadle', 'inbounds', 'mode') || 'tun') === 'tun' ? _('TUN') : _('TProxy'));
		parts.push(_('%d active rules').format(runtimeInfo().ruleCount));
		parts.push(_('%d subscriptions').format(uci.sections('treadle', 'subscription').length));
		return [
			E('span', {}, [ parts.join(' · ') ]),
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral', 'style': 'margin-left:auto;',
				'click': ui.createHandlerFn(this, '_showConfig')
			}, [ _('View generated config') ])
		];
	},

	// ── Kept controls ─────────────────────────────────────────────────────

	_renderActions: function(state) {
		// running → Stop + Restart
		// paused  → Start + Restart (Start clears the marker)
		// stopped → Start + Restart (recover an unexpectedly-down service)
		if (state === 'running') {
			return [
				E('button', {
					'class': 'btn cbi-button cbi-button-remove',
					'click': ui.createHandlerFn(this, 'handleStop')
				}, [ _('Stop') ]),
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, 'handleRestart')
				}, [ _('Restart') ])
			];
		}
		return [
			E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(this, 'handleStart')
			}, [ _('Start') ]),
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'click': ui.createHandlerFn(this, 'handleRestart')
			}, [ _('Restart') ])
		];
	},

	// Clickable pointer to another Treadle tab — routes through the host's
	// _activate so it behaves exactly like clicking the tab itself
	// (panel teardown, session-store update).
	_tabLink: function(tabId, label) {
		var self = this;
		return E('a', {
			'href': '#',
			'click': function(ev) {
				ev.preventDefault();
				if (self._treadleHost)
					self._treadleHost._activate(tabId);
			}
		}, [ label ]);
	},

	// First-run checklist — the three steps from a fresh install to
	// traffic flowing, with the tab names as live links.
	_renderGetStarted: function() {
		var steps = [
			E('li', {}, [
				_('Add a subscription on the '),
				this._tabLink('nodes', _('Nodes')),
				_(' tab and press Sync — or configure a node manually there.')
			]),
			E('li', {}, [
				_('Pick the default node on the '),
				this._tabLink('routing', _('Routing')),
				_(' tab — or right here on the runtime row, once nodes exist.')
			]),
			E('li', {}, [ _('Tick "Enable Treadle" above.') ])
		];
		return E('div', { 'class': 'cbi-section' }, [
			E('h4', { 'style': 'margin:0.4em 0 0.3em;' }, [ _('Get started') ]),
			E('div', { 'class': 'cbi-section-descr' }, [
				_('Nothing is configured yet — three steps to get traffic flowing:')
			]),
			E('ol', { 'style': 'margin:0.4em 0 0.4em 1.6em; line-height:1.7;' }, steps)
		]);
	},

	// Inline default-node switcher. Offers the same
	// choice list as the Routing tab's "Default node" dropdown — both come
	// from subs.serverEntries, so the two controls cannot diverge.
	// Changing it commits and applies immediately: Status is the
	// immediate-action surface (Enable, Stop/Start/Restart all act on
	// click), and a default-node change is only useful once applied.
	// Group-member forcing via the clash API is deliberately NOT attempted
	// here — sing-box's urltest groups pick members by latency, and forced
	// selection would need verification on real hardware first.
	_renderNodeSwitcher: function(currentTag) {
		var self = this;
		currentTag = currentTag || '';
		var sel = E('select', {
			'id': 'treadle-default-node',
			'class': 'cbi-input-select',
			'style': 'font-size:0.85em; max-width:20em;',
			'title': _('Default node — traffic not matched by any routing rule goes here. Changing it applies immediately.'),
			'change': function(ev) { self._handleNodeSwitch(ev.currentTarget); }
		});
		if (!currentTag)
			sel.appendChild(E('option', { 'value': '', 'disabled': 'disabled' }, [ _('— no default —') ]));
		sel.appendChild(E('option', { 'value': 'direct' }, [ _('direct (no proxy)') ]));
		sel.appendChild(E('option', { 'value': 'block'  }, [ _('block (drop)') ]));
		var seen = { direct: true, block: true };
		subs.serverEntries(this._outbounds).forEach(function(e) {
			sel.appendChild(E('option', { 'value': e.tag }, [ e.label ]));
			seen[e.tag] = true;
		});
		// A dangling final_outbound (node deleted, subscription gone) still
		// shows as the selected value instead of silently displaying the
		// first option as if it were active.
		if (currentTag && !seen[currentTag])
			sel.appendChild(E('option', { 'value': currentTag }, [
				currentTag + ' ' + _('(missing)')
			]));
		sel.value = currentTag;
		sel._treadleCurrent = currentTag;
		return sel;
	},

	_handleNodeSwitch: function(sel) {
		var self = this;
		var newTag = sel.value;
		var oldTag = sel._treadleCurrent || '';
		if (!newTag || newTag === oldTag)
			return;
		var label = (sel.selectedIndex >= 0)
			? sel.options[sel.selectedIndex].text : newTag;
		// Apply commits the whole staged set — when edits from other tabs
		// are riding along, never commit them silently (same courtesy the
		// mode switch extends to staged changes).
		return uci.changes().then(function(changes) {
			var n = 0;
			for (var k in changes) {
				if (changes.hasOwnProperty(k) && Array.isArray(changes[k]))
					n += changes[k].length;
			}
			if (n === 0)
				return self._applyNodeSwitch(sel, oldTag, newTag);
			ui.showModal(_('Set default node?'), [
				E('p', {}, [
					_('Setting the default node to "%s" applies immediately — and will also commit %d change(s) staged by earlier edits.')
						.format(label, n)
				]),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': function() {
							sel.value = oldTag;
							ui.hideModal();
						}
					}, [ _('Cancel') ]),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-apply',
						'click': function() {
							ui.hideModal();
							self._applyNodeSwitch(sel, oldTag, newTag);
						}
					}, [ _('Apply') ])
				])
			]);
		});
	},

	_applyNodeSwitch: function(sel, oldTag, newTag) {
		sel.disabled = true;
		if (!uci.get('treadle', 'routing'))
			uci.add('treadle', 'routing', 'routing');
		uci.set('treadle', 'routing', 'final_outbound', newTag);
		return uci.save().then(function() {
			// Same plain (non-rollback) apply the panel footers use — see
			// formpanel.saveApply for why the rollback ceremony is skipped.
			// It commits the staged set, the procd config trigger reloads
			// sing-box, and the page reload lands back on this tab via the
			// session store with the new node showing.
			return ui.changes.apply();
		}).catch(function(err) {
			// The staged write failed — reload the UCI cache so the local
			// edit cannot ride along with an unrelated Save later, then
			// put the control back.
			uci.unload('treadle');
			return uci.load('treadle').then(function() {
				sel.disabled = false;
				sel.value = oldTag;
				ui.addNotification(null, E('p', _('Failed to set the default node: ') +
					((err && err.message) ? err.message : err)), 'error');
			});
		});
	},

	// Surface transport-level RPC failures (rpcd reload, network error,
	// JSON parse) as a notification instead of letting them disappear
	// into ui.createHandlerFn's generic handler. Without a .catch,
	// _refreshStatusNow also doesn't run and the post-action refresh is
	// silently skipped.
	_notifyRpcError: function(label, err) {
		var msg = (err && err.message) ? err.message : String(err);
		ui.addNotification(null, E('p', label + ': ' + msg), 'error');
	},

	handleToggleEnabled: function(ev) {
		var self = this;
		var cb = document.getElementById('treadle-enable-checkbox');
		var on = !!(cb && cb.checked);
		return callSetEnabled(on).then(function(res) {
			if (res && res.ok === false) {
				ui.addNotification(null, E('p',
					on ? _('Enable failed — check the log below.')
					   : _('Disable failed — check the log below.')), 'error');
			} else {
				ui.addNotification(null, E('p',
					on ? _('Treadle enabled.') : _('Treadle disabled.')), 'info');
			}
			return self._refreshStatusNow();
		}).catch(function(err) {
			self._notifyRpcError(on ? _('Enable failed') : _('Disable failed'), err);
			return self._refreshStatusNow();
		});
	},

	handleStart: function() {
		var self = this;
		return callStart().then(function(res) {
			if (res && res.ok === false) {
				ui.addNotification(null, E('p',
					res.error ? _('Start failed: ') + res.error
					          : _('Start failed — check the log below.')), 'error');
			} else {
				ui.addNotification(null, E('p', _('Service started.')), 'info');
			}
			return self._refreshStatusNow();
		}).catch(function(err) {
			self._notifyRpcError(_('Start failed'), err);
			return self._refreshStatusNow();
		});
	},

	handleStop: function() {
		var self = this;
		return callStop().then(function() {
			ui.addNotification(null, E('p',
				_('Service stopped — will resume on next reboot.')), 'info');
			return self._refreshStatusNow();
		}).catch(function(err) {
			self._notifyRpcError(_('Stop failed'), err);
			return self._refreshStatusNow();
		});
	},

	handleRestart: function() {
		var self = this;
		return callRestart().then(function(res) {
			if (res && res.ok === false) {
				ui.addNotification(null, E('p', _('Restart failed — check the log below.')), 'error');
			} else {
				ui.addNotification(null, E('p', _('Service restarted.')), 'info');
			}
			return self._refreshStatusNow();
		}).catch(function(err) {
			self._notifyRpcError(_('Restart failed'), err);
			return self._refreshStatusNow();
		});
	},

	// Bring every section in line with one get_dashboard reply. Called by
	// render() for the first paint and by every poll tick after it. Works on
	// the element references render() kept, so it also runs before the
	// panel is attached.
	_apply: function(d, withLogs) {
		var els = this._els;
		var status = d.status || {};
		var g = d.groups || { groups: [] };
		var stats = d.stats || {};
		var state = this._runtimeState(status);
		var enabled = !!status.enabled;
		var running = state === 'running';
		this._lastGroups = g;

		// Reflect an out-of-band change to `enabled` (a CLI `uci set`, a
		// concurrent admin) without firing the click handler.
		var cb = els.enable.querySelector('input');
		if (cb && cb.checked !== enabled)
			dom.content(els.enable, this._renderEnable(enabled));

		dom.content(els.compat, renderWarnings(status));
		dom.content(els.badge, [ this._renderBadge(state, enabled) ]);
		els.uptime.textContent = (running && status.uptime_s != null)
			? _('for %s').format(formatUptime(status.uptime_s)) : '';

		// "now using HK-03 · 106 ms" when the default is a group; just the
		// latency when it is a single node.
		var fin = uci.get('treadle', 'routing', 'final_outbound') || '';
		var using = '';
		arr(g.groups).forEach(function(x) {
			if (x.tag === fin && x.now)
				using = _('now using %s').format(x.now) +
					(x.delay_ms ? ' · ' + x.delay_ms + ' ms' : '');
		});
		arr(g.nodes).forEach(function(x) {
			if (x.tag === fin && x.delay_ms)
				using = x.delay_ms + ' ms';
		});
		els.using.textContent = running ? using : '';

		var sig = state + '|' + enabled;
		if (sig !== this._sigs.actions) {
			this._sigs.actions = sig;
			dom.content(els.actions, this._renderActions(state));
		}
		els.pause.style.display = (enabled && state === 'paused') ? '' : 'none';

		// While disabled, nothing that describes a running service is shown:
		// only the badge, the Enable toggle and the log.
		els.actions.style.display = enabled ? 'flex' : 'none';
		els.tiles.style.display = (enabled && (running || stats.error)) ? '' : 'none';
		dom.content(els.tiles, this._renderTiles(stats));

		dom.content(els.banner, this._renderBanner(g, running));

		var health = [
			Object.assign({ label: _('Connectivity') }, this._connectivityHealth(g, running)),
			Object.assign({ label: _('DNS') }, this._dnsHealth()),
			Object.assign({ label: _('Subscriptions') }, this._subscriptionHealth(d.subs))
		];
		els.health.style.display = enabled ? '' : 'none';
		var hsig = JSON.stringify(health);
		if (hsig !== this._sigs.health) {
			this._sigs.health = hsig;
			dom.content(els.health, this._renderHealth(health));
		}

		if (enabled && running) {
			this._renderInUse(g);
		} else {
			els.inuse.style.display = 'none';
			this._sigs.inuse = null;
		}

		if (withLogs && d.logs) {
			this._logs = d.logs;
			this._renderLog();
		}
		dom.content(els.footer, this._renderFooter(status));
	},

	// One poll tick, or an immediate refresh after a start/stop/toggle
	// (called with no argument, so logs are included). One RPC, so one
	// handler process on the router per tick.
	_refreshStatusNow: function(logsDue) {
		var self = this;
		var withLogs = (logsDue !== false);
		// Omit `logs` rather than sending null: rpcd checks arguments against
		// the method's declared types, and `logs` is declared as a number.
		return callGetDashboard(withLogs ? TAIL_LINES : undefined).then(function(d) {
			self._apply(d || {}, withLogs);
			self._scheduleStatusRefresh();
		});
	},

	_scheduleStatusRefresh: function() {
		// Bail if the tab's DOM is gone (switched away) so a stray in-flight
		// poll cannot resurrect the timer after _teardown.
		if (!document.getElementById('treadle-status-badge'))
			return;
		if (this._statusTimer)
			clearTimeout(this._statusTimer);
		this._statusTimer = setTimeout(L.bind(function() {
			this._statusTimer = null;
			// A hidden browser tab skips its ticks: a LuCI tab left open in
			// the background would otherwise keep a handler process (and a
			// whole-syslog scan every 10 s) running on the router for as
			// long as the session lasts. Resume when it is shown again.
			if (document.hidden) {
				this._resumeWhenVisible();
				return;
			}
			// Errors are swallowed by design: a transient WAN outage or a
			// brief rpcd hiccup should not pile error notifications onto
			// the user every 2 seconds — visible failure modes (sing-box
			// stopped, clash disabled) come through as well-typed empty
			// results. _refreshStatusNow reschedules on success; reschedule
			// here on failure so the next tick retries.
			this._tick++;
			this._refreshStatusNow(this._tick % LOG_EVERY === 0)
				.catch(L.bind(this._scheduleStatusRefresh, this));
		}, this), POLL_MS);
	},

	_showFullLog: function() {
		ui.showModal(_('Service log'), [
			E('div', { 'class': 'spinning' }, [ _('Loading…') ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Close') ])
			])
		]);
		return callGetLog(FULL_LOG_LINES).then(function(data) {
			var lines = formatLog(data && data.log);
			var ta = E('textarea', {
				'class': 'cbi-input-textarea',
				'readonly': 'readonly',
				'wrap': 'off',
				'style': 'width:100%; height:60vh; font-family:monospace; ' +
				         'font-size:0.8em; line-height:1.35;'
			}, [ lines ]);
			ui.showModal(_('Service log (last %d lines)').format(FULL_LOG_LINES), [
				ta,
				E('div', { 'class': 'right', 'style': 'margin-top:0.5em;' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Close') ])
				])
			]);
			// Defer scroll until the modal is mounted; without this the
			// scrollHeight is read before layout completes.
			requestAnimationFrame(function() { ta.scrollTop = ta.scrollHeight; });
		}).catch(function() {
			ui.showModal(_('Service log'), [
				E('p', {}, [ _('Failed to load the log.') ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Close') ])
				])
			]);
		});
	},

	_showConfig: function() {
		ui.showModal(_('Generated configuration'), [
			E('div', { 'class': 'spinning' }, [ _('Loading…') ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Close') ])
			])
		]);
		return callGetConfig().then(function(data) {
			data = data || {};
			var path = data.path || '/var/etc/treadle/sing-box.json';
			var json = data.json || '';
			var content = [
				E('div', { 'style': 'display:flex; align-items:center; gap:0.5em; margin-bottom:0.4em; flex-wrap:wrap;' }, [
					E('span', { 'style': 'font-size:0.85em; opacity:0.7;' }, [ _('Target file:') ]),
					E('code', { 'style': 'font-size:0.85em;' }, [ path ]),
					data.exists
						? E('span', { 'class': 'label success', 'style': 'padding:1px 7px; border-radius:3px; text-transform:none;' }, [ _('running file present') ])
						: E('span', { 'class': 'label warning', 'style': 'padding:1px 7px; border-radius:3px; text-transform:none;' }, [ _('preview only — not yet applied') ])
				])
			];
			if (data.error)
				content.push(E('div', { 'class': 'alert-message warning', 'style': 'margin-bottom:0.4em; font-size:0.85em;' }, [
					E('strong', {}, [ _('Generator error:') ]), ' ',
					E('code', {}, [ data.error ])
				]));
			content.push(E('textarea', {
				'class': 'cbi-input-textarea',
				'readonly': 'readonly',
				'spellcheck': 'false',
				'style': 'width:100%; height:60vh; font-family:monospace; ' +
				         'font-size:0.8em; line-height:1.4; background:rgba(128,128,128,0.05);'
			}, [ json ]));
			content.push(E('div', { 'style': 'margin-top:0.5em; display:flex; justify-content:space-between; gap:0.4em;' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'disabled': json ? null : 'disabled',
					'click': function() { downloadConfig(json); }
				}, [ _('Download config') ]),
				E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Close') ])
			]));
			ui.showModal(_('Generated configuration'), content);
		}).catch(function() {
			ui.showModal(_('Generated configuration'), [
				E('p', {}, [ _('Failed to load the generated config.') ]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Close') ])
				])
			]);
		});
	},

	// Called by the host shell when this panel's tab is switched away.
	// One listener at most. On becoming visible it refreshes everything at
	// once, logs included, since a tab shown after a long absence is stale;
	// that refresh reschedules the normal poll.
	_resumeWhenVisible: function() {
		if (this._onVisible)
			return;
		this._onVisible = L.bind(function() {
			if (document.hidden)
				return;
			this._stopWaitingVisible();
			if (!document.getElementById('treadle-status-badge'))
				return;
			this._refreshStatusNow(true)
				.catch(L.bind(this._scheduleStatusRefresh, this));
		}, this);
		document.addEventListener('visibilitychange', this._onVisible);
	},

	_stopWaitingVisible: function() {
		if (this._onVisible) {
			document.removeEventListener('visibilitychange', this._onVisible);
			this._onVisible = null;
		}
	},

	_teardown: function() {
		if (this._statusTimer) {
			clearTimeout(this._statusTimer);
			this._statusTimer = null;
		}
		this._stopWaitingVisible();
	},

	handleSave:      null,
	handleSaveApply: null,
	handleReset:     null
});
