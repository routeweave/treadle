// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Status tab: the dashboard. Answers "is it working?" at a glance and "why
// not?" without leaving the page.
//
// Two distinct concepts, two distinct controls:
//
//   * Enable toggle (persistent, UCI global.enabled) — installs-but-dormant
//     vs. installed-and-running. Off hides the runtime row entirely; the
//     service won't autostart and the watchdog stays idle.
//   * Stop / Start / Restart (transient, tmpfs marker) — diagnostic
//     pause/resume/cycle without flipping the persistent flag. Reboot
//     clears the marker, so an enabled-but-paused service resumes
//     automatically.
//
// Layout (top → bottom):
//   [ ✓ ] Enable Treadle                                 ← persistent
//   ● Running / ○ Paused / ● Stopped  via  <active-node>  [actions]
//   Subscriptions: N · Active rules: N
//   <recent activity — 20-line log tail, auto-refreshed>
//   [View full log] [View generated config]
//   sing-box X.Y.Z · Mode
//
// One 2s poller drives the whole dashboard — service status (badge +
// actions + footer), groups, traffic and the log tails are fetched in a
// single batched tick on one rescheduled setTimeout, torn down on tab
// switch via _teardown. The full log viewer and the generated-config
// preview live in on-demand modals (the prior Diagnostics panel rendered
// them inline; here they would crowd the glance-first layout).
//
// The active-node line shows `routing.final_outbound` from UCI — the tag
// of the default node the rule chain falls through to (a group counts as a
// node here). Subscription nodes render as "<subscription>/<tag>" so two
// nodes that happen to share a tag across subscriptions can be told apart;
// manual nodes and groups render as the bare tag. Same formatting as the
// Routing tab's dropdown. In Advanced mode it is an inline switcher (see
// _renderNodeSwitcher); Basic mode keeps the read-only text — its server
// picker lives on the Basic tab.

'use strict';
'require baseclass';
'require rpc';
'require ui';
'require uci';
'require view.treadle.lib.subs as subs';
'require view.treadle.lib.badges as badges';

// Everything a poll tick needs, from one handler process:
//   status — enabled / running / paused / version / mode
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
	params: ['logs'],
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

var TAIL_LINES     = 10;
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

// Format the active-outbound tag for display: "<subscription>/<tag>" for a
// subscription node, just "<tag>" for a manual node or a group (groups don't
// appear in list_outbounds, so the lookup misses and falls through to the
// raw tag — which is what we want, a group is a single named entity). Same
// shape as the Routing tab's dropdown labels (routing.js:addServers).
// Map an internal outbound tag to a friendlier label for the Status UI. The
// only special case today is the Basic-mode synthesised urltest: its tag has
// to stay stable (it appears in sing-box logs, the clash cache file and the
// /proxies API), so the rename happens at display time only.
var TAG_DISPLAY = { 'basic-auto': _('Auto') };

function displayTag(tag) {
	return (tag != null && TAG_DISPLAY[tag]) || tag;
}

function formatActiveNode(tag, outbounds) {
	if (!tag) return '';
	if (tag === 'direct') return _('direct (no proxy)');
	if (tag === 'block')  return _('block (drop)');
	if (TAG_DISPLAY[tag])  return TAG_DISPLAY[tag];
	var subName = subs.nameMap();
	for (var i = 0; i < (outbounds || []).length; i++) {
		var ob = outbounds[i];
		if (ob.tag !== tag) continue;
		return subs.labelFor(ob.tag, ob.subscription, subName);
	}
	return tag;
}

// Active outbound for the runtime header. Advanced reads
// treadle.routing.final_outbound; Basic synthesises from treadle.basic.server
// after filtering picks that no longer resolve against the live outbound
// set (subscription removed, node renamed). Same filter the builder applies,
// otherwise Status displays "via Auto" for a config that doesn't have a
// basic-auto group. Rule count stays plain in both modes — Basic just hides
// the row that would display it (along with the sing-box/mode footer).
function runtimeInfo(outbounds) {
	var uiMode = uci.get('treadle', 'global', 'mode');
	if (uiMode !== 'basic' && uiMode !== 'advanced') uiMode = 'advanced';

	var tag;
	if (uiMode === 'basic') {
		var servers = uci.get('treadle', 'basic', 'server');
		if (!Array.isArray(servers))
			servers = servers ? [ servers ] : [];
		var live = {};
		(outbounds || []).forEach(function(ob) { if (ob && ob.tag) live[ob.tag] = true; });
		var members = [];
		var seen = {};
		servers.forEach(function(t) {
			if (live[t] && !seen[t]) { members.push(t); seen[t] = true; }
		});
		if (members.length === 1)      tag = members[0];
		else if (members.length > 1)   tag = 'basic-auto';
		else                           tag = '';
	} else {
		tag = uci.get('treadle', 'routing', 'final_outbound') || '';
	}

	var ruleCount = uci.sections('treadle', 'rule').filter(function(r) {
		return r.enabled !== '0';
	}).length;

	return {
		tag:       tag,
		active:    formatActiveNode(tag, outbounds),
		ruleCount: ruleCount,
		uiMode:    uiMode
	};
}

// Trigger a browser download of the given JSON text as sing-box.json. Uses a
// Blob URL rather than a data: URL — large configs would otherwise blow past
// the data-URL length limit some browsers still enforce.
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

return baseclass.extend({
	_statusTimer: null,
	_tick: 0,

	load: function() {
		// All RPCs degrade gracefully — a missing one leaves the relevant
		// row blank rather than blanking the tab.
		return Promise.all([
			callGetDashboard(TAIL_LINES).catch(function() { return {}; }),
			callListOutbounds().catch(function() { return {}; }),
			uci.load('treadle').catch(function() { return null; })
		]).then(function(r) {
			var d = r[0] || {};
			return [ d.status, d.logs, r[1], d.groups, d.stats ];
		});
	},

	render: function(results) {
		var status     = (results && results[0]) || {};
		var logsData   = (results && results[1]) || {};
		// luci.jsonc serialises an empty Lua array as `{}`, so list_outbounds
		// arrives as an object (not []) when no nodes exist. Coerce defensively
		// — same guard the Nodes and Routing panels use — so the runtimeInfo()
		// .forEach below doesn't blow up the whole tab on a fresh install.
		var rawOut     = ((results && results[2]) || {}).outbounds;
		var outbounds  = Array.isArray(rawOut) ? rawOut : [];
		var groupsData = (results && results[3]) || { groups: [] };
		var statsData  = (results && results[4]) || {};
		var treadleText  = formatLog(logsData.treadle);
		var singboxText = formatLog(logsData.singbox);
		// Cache the outbound list for _updateStatus to reuse when the
		// runtime section is rebuilt on an enable-flip. final_outbound
		// rarely changes mid-session, so a snapshot at load time is fine;
		// the user has to leave the tab to add a node anyway.
		this._outbounds = outbounds;
		this._running   = !!status.running;

		var info     = runtimeInfo(outbounds);
		var active   = info.active;
		var mode     = uci.get('treadle', 'inbounds', 'mode') || 'tproxy';
		var subCount = uci.sections('treadle', 'subscription').length;
		var manualCount = uci.sections('treadle', 'node').length;

		var self = this;

		var node = E('div', { 'class': 'cbi-map' }, [

			// ── Enable toggle ──────────────────────────────────────────
			// Persistent master switch (UCI global.enabled). Off = the
			// service won't autostart, watchdog stays idle, runtime row
			// hidden. The container is id'd so _updateStatus can refresh
			// the checkbox state without re-rendering the whole panel
			// (matters for a poll discovering an out-of-band UCI change).
			E('div', { 'class': 'cbi-section' }, [
				E('div', {
					'id': 'treadle-enable-row',
					'style': 'display:flex; align-items:center; gap:0.6em;'
				}, this._renderEnable(status.enabled))
			]),

			// ── Get started ────────────────────────────────────────────
			// First-run checklist, shown only while nothing at all is
			// configured (no subscriptions, no nodes of any kind). It
			// disappears after the first subscription or node exists; the
			// later steps are then covered by the inline pointers (the
			// no-default switcher placeholder, the Basic no-server
			// warning). Static per render — adding a node happens on
			// another tab, and returning here re-renders the panel.
			(subCount === 0 && manualCount === 0 && outbounds.length === 0)
				? this._renderGetStarted(info.uiMode)
				: '',

			// ── Runtime row ────────────────────────────────────────────
			// Hidden entirely when the master switch is off — nothing to
			// say and nothing to do. The container is rebuilt by
			// _updateStatus on every poll tick so the runtime state
			// (running / paused / unexpectedly-stopped) and its action
			// toolbar follow the service.
			E('div', {
				'id': 'treadle-runtime-section',
				'class': 'cbi-section',
				'style': status.enabled ? '' : 'display:none;'
			}, this._renderRuntime(status, active, subCount, info, mode)),

			// ── Traffic ────────────────────────────────────────────────
			// One-row digest of /connections from the daemon snapshot:
			// instantaneous bytes/sec each way (10s-averaged), open
			// connection count, and cumulative totals since sing-box
			// started. Hidden when clash API is off; container is always
			// present so _updateClashStats can flip it back on without a
			// page re-render.
			E('div', {
				'id': 'treadle-traffic-section',
				'class': 'cbi-section',
				'style': (status.running && statsData && !statsData.error) ? '' : 'display:none;'
			}, this._renderTraffic(statsData)),

			// ── Active groups ──────────────────────────────────────────
			// One row per urltest group, showing the currently active
			// member (clash `now`), its last-known latency, and the
			// group's own tuning (interval/tolerance). Hidden when clash
			// API is off, when the daemon has nothing yet, or when there
			// are no groups — the container is always present so
			// _updateGroups can flip visibility without re-rendering the
			// page.
			E('div', {
				'id': 'treadle-groups-section',
				'class': 'cbi-section',
				'style': (Array.isArray(groupsData.groups) && groupsData.groups.length) ? '' : 'display:none;'
			}, this._renderGroups(groupsData)),

			// ── Recent activity ────────────────────────────────────────
			// Two stacked boxes — Treadle control-plane events (sparse) and
			// sing-box service log (verbose). Each is a fixed-row textarea,
			// no vertical scroll; long lines still scroll horizontally. The
			// cleanLogLine pass trims each line to "YYYY/MM/DD HH:MM:SS <msg>"
			// so the visible width fits comfortably.
			E('div', { 'class': 'cbi-section' }, [
				E('h4', { 'style': 'margin:0.4em 0 0.3em;' }, [ _('Treadle log') ]),
				E('textarea', {
					'id': 'treadle-log-treadle',
					'class': 'cbi-input-textarea',
					'readonly': 'readonly',
					'wrap': 'off',
					'rows': String(TAIL_LINES),
					'style': 'width:100%; resize:none; overflow-y:hidden; ' +
					         'font-family:monospace; font-size:0.8em; ' +
					         'line-height:1.35; background:rgba(128,128,128,0.05);'
				}, [ treadleText ]),
				E('h4', { 'style': 'margin:1em 0 0.3em;' }, [ _('sing-box log') ]),
				E('textarea', {
					'id': 'treadle-log-singbox',
					'class': 'cbi-input-textarea',
					'readonly': 'readonly',
					'wrap': 'off',
					'rows': String(TAIL_LINES),
					'style': 'width:100%; resize:none; overflow-y:hidden; ' +
					         'font-family:monospace; font-size:0.8em; ' +
					         'line-height:1.35; background:rgba(128,128,128,0.05);'
				}, [ singboxText ]),
				// "View full log" and "View generated config" are debug
				// surfaces hidden in Basic mode, consistent with hiding the
				// Subscriptions/Rules count row and the sing-box version
				// footer (commit 2afeb47).
				E('div', {
					'style': 'margin:0.5em 0 2em; display:flex; gap:0.4em;' +
					         (info.uiMode === 'basic' ? ' display:none;' : '')
				}, [
					E('button', {
						'class': 'btn cbi-button cbi-button-neutral',
						'click': ui.createHandlerFn(self, '_showFullLog')
					}, [ _('View full log') ]),
					E('button', {
						'class': 'btn cbi-button cbi-button-neutral',
						'click': ui.createHandlerFn(self, '_showConfig')
					}, [ _('View generated config') ])
				])
			]),

		]);

		// Polling and scroll-to-bottom both have to wait until the panel's
		// DOM is actually attached: render() builds a detached node and
		// the host shell (main.js) appends it in a .then microtask after
		// we return. requestAnimationFrame fires after that microtask, so
		// at this point document.getElementById can finally see our IDs.
		// Without this, _scheduleStatusRefresh's "is the panel mounted?"
		// guard short-circuits the initial call and polling never starts
		// on a fresh page load — only the user-action paths
		// (handleStart/Stop/Restart/ToggleEnabled call _refreshStatusNow
		// which then schedules) would resurrect it, which is why the
		// freeze was easy to miss before live traffic numbers made it
		// visible.
		requestAnimationFrame(L.bind(function() {
			this._scheduleStatusRefresh();
			['treadle-log-treadle', 'treadle-log-singbox'].forEach(function(id) {
				var el = document.getElementById(id);
				if (el) el.scrollTop = el.scrollHeight;
			});
		}, this));

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

	_renderBadge: function(state) {
		// Plain colored text rather than a `label-*` pill — pills are sized
		// for inline form labels and look cramped at the status row.
		var spec = {
			running: { color: '#26a65b', text: _('● Running') },
			paused:  { color: '#888',    text: _('○ Paused')  },
			stopped: { color: '#dc3545', text: _('● Stopped') }
		}[state];
		return E('span', {
			'style': 'color:' + spec.color + '; font-weight:bold;'
		}, [ spec.text ]);
	},

	_renderFooter: function(status, mode) {
		// No autostart read-out: the Enable toggle is the visible control
		// for that flag, so the footer would just echo it. Mode and version
		// are not shown elsewhere on the page.
		return _('%s · Mode: %s').format(shortVersion(status.version), mode);
	},

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

	_renderEnable: function(enabled) {
		// A plain checkbox + label, big enough that "is Treadle turned on?"
		// is a glance question. ui.createHandlerFn binds `this` and the
		// notification-on-error wrapping is shared with the runtime
		// handlers.
		var cb = E('input', {
			'type': 'checkbox',
			'id': 'treadle-enable-checkbox',
			'class': 'cbi-input-checkbox',
			'style': 'width:1.2em; height:1.2em; margin:0;',
			'click': ui.createHandlerFn(this, 'handleToggleEnabled')
		});
		if (enabled) cb.checked = true;
		return [
			cb,
			E('label', {
				'for': 'treadle-enable-checkbox',
				'style': 'font-size:1.15em; font-weight:bold; cursor:pointer; margin:0;'
			}, [ _('Enable Treadle') ]),
			// "applies immediately" because this toggle commits through rpcd
			// on click — unlike everything else in Treadle, there is no
			// Save & Apply step between the click and the service action.
			E('span', { 'style': 'opacity:0.6; font-size:0.9em;' }, [
				enabled
					? _('— sing-box runs and autostarts at boot · applies immediately')
					: _('— installed but dormant; no service, no autostart · applies immediately')
			])
		];
	},

	// Clickable pointer to another Treadle tab — routes through the host's
	// _activate so it behaves exactly like clicking the tab itself
	// (panel teardown, session-store update). Same host-delegation
	// pattern as basic.js _switchToAdvanced.
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
	// traffic flowing, with the tab names as live links. Mode-aware:
	// Basic does everything on one tab, Advanced spans Nodes + Routing.
	_renderGetStarted: function(uiMode) {
		var steps;
		if (uiMode === 'basic') {
			steps = [
				E('li', {}, [
					_('Add a subscription on the '),
					this._tabLink('basic', _('Basic')),
					_(' tab and press Sync.')
				]),
				E('li', {}, [
					_('Pick one or more servers under "Default server(s)" on the same tab.')
				]),
				E('li', {}, [ _('Tick "Enable Treadle" above.') ])
			];
		} else {
			steps = [
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
		}
		return E('div', { 'class': 'cbi-section' }, [
			E('h4', { 'style': 'margin:0.4em 0 0.3em;' }, [ _('Get started') ]),
			E('div', { 'class': 'cbi-section-descr' }, [
				_('Nothing is configured yet — three steps to get traffic flowing:')
			]),
			E('ol', { 'style': 'margin:0.4em 0 0.4em 1.6em; line-height:1.7;' }, steps)
		]);
	},

	// Inline default-node switcher (Advanced mode only). Offers the same
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

	// Compact latency badge — the shared lib/badges.js renderer, so the
	// Status Groups column and the Nodes Latency column agree on the
	// 300/600 ms green→yellow→red thresholds.
	_renderLatency: function(ms) {
		return badges.formatLatency(
			(typeof ms === 'number' && ms > 0) ? { delay_ms: ms } : null);
	},

	// "urltest · every 1m0s · ±50ms" — surfaces the configured tuning right
	// next to the evidence of it churning, so the user can read both at
	// once without leaving the page.
	_renderGroupMeta: function(g) {
		if (g.type === 'urltest') {
			var parts = [ _('urltest') ];
			if (g.interval && g.interval !== '')
				parts.push(_('every %s').format(g.interval));
			if (g.tolerance && g.tolerance !== '')
				parts.push('±' + g.tolerance + 'ms');
			return parts.join(' · ');
		}
		return g.type || '';
	},

	// One-line traffic digest. Four columns rendered as inline pieces, not
	// a table — they're a *single* reading at a moment in time, not a
	// growing list. Each piece is id'd so _updateClashStats can refresh
	// the values in place without rebuilding the row (avoids a layout
	// flicker every 2s).
	_renderTraffic: function(stats) {
		stats = stats || {};
		var hasMem = (typeof stats.mem_inuse === 'number' && stats.mem_inuse > 0);
		var pieces = [
			E('span', {}, [
				E('span', { 'style': 'opacity:0.6;' }, [ '↓ ' ]),
				E('strong', { 'id': 'treadle-traffic-down' }, [ formatRate(stats.down_bps) ])
			]),
			E('span', {}, [
				E('span', { 'style': 'opacity:0.6;' }, [ '↑ ' ]),
				E('strong', { 'id': 'treadle-traffic-up' }, [ formatRate(stats.up_bps) ])
			]),
			E('span', { 'style': 'opacity:0.7;' }, [
				E('span', { 'id': 'treadle-traffic-conns' }, [ String(stats.conn_count || 0) ]),
				' ', _('connections')
			]),
			E('span', { 'style': 'opacity:0.7;' }, [
				_('session:'), ' ',
				E('span', { 'id': 'treadle-traffic-total-down' }, [ formatBytes(stats.total_down) ]),
				' ↓ / ',
				E('span', { 'id': 'treadle-traffic-total-up' }, [ formatBytes(stats.total_up) ]),
				' ↑'
			])
		];
		if (hasMem) {
			pieces.push(E('span', { 'style': 'opacity:0.7;' }, [
				_('memory:'), ' ',
				E('span', { 'id': 'treadle-traffic-mem' }, [ formatBytes(stats.mem_inuse) ])
			]));
		}
		return [
			E('h4', { 'style': 'margin:0.2em 0 0.4em;' }, [ _('Traffic') ]),
			E('div', {
				'style': 'display:flex; flex-wrap:wrap; gap:1.2em; ' +
				         'align-items:baseline; font-size:0.95em;'
			}, pieces)
		];
	},

	// Render every group as one row of a compact section table. The empty
	// case (no groups, clash API off, daemon hasn't primed the snapshot
	// yet) returns a single message row so the panel never collapses to
	// nothing once it's been shown — the caller hides the whole section
	// when there are no groups, so this branch is only seen mid-flip.
	_renderGroups: function(data) {
		// luci.jsonc can't tell empty arrays from empty objects at the Lua
		// boundary — an empty `out = {}` in get_active_groups serializes
		// as `{}`, which arrives here as an object, not an array. The
		// section is hidden in that case anyway, but _renderGroups is
		// still invoked to build the contents; coerce defensively so the
		// `.forEach` below doesn't blow up the whole tab.
		var groups = (data && Array.isArray(data.groups)) ? data.groups : [];
		var rows = [];
		var self = this;
		groups.forEach(function(g) {
			rows.push(E('tr', { 'class': 'tr cbi-section-table-row' }, [
				E('td', { 'class': 'td', 'style': 'font-weight:bold;' }, [ displayTag(g.tag) ]),
				E('td', { 'class': 'td', 'style': 'opacity:0.6;' }, [ '→' ]),
				E('td', { 'class': 'td' }, [ g.now || E('span', { 'style': 'opacity:0.5;' }, [ '—' ]) ]),
				E('td', { 'class': 'td' }, [ self._renderLatency(g.delay_ms) ]),
				E('td', {
					'class': 'td',
					'style': 'font-size:0.85em; opacity:0.7;'
				}, [ self._renderGroupMeta(g) ])
			]));
		});
		if (rows.length === 0) {
			rows.push(E('tr', { 'class': 'tr cbi-section-table-row' }, [
				E('td', {
					'class': 'td',
					'colspan': '5',
					'style': 'opacity:0.6; font-style:italic;'
				}, [
					(data && data.error)
						? _('Active-node tracking is disabled — enable the clash API in Settings to see this.')
						: _('No groups configured yet, or daemon still priming.')
				])
			]));
		}
		return [
			E('h4', { 'style': 'margin:0.2em 0 0.4em;' }, [ _('Groups') ]),
			E('table', { 'class': 'table cbi-section-table' }, [
				E('tbody', {}, rows)
			])
		];
	},

	_renderRuntime: function(status, active, subCount, info, mode) {
		// The whole runtime section (badge row, counts, footer). Called
		// from render() to build the initial DOM, and again from
		// _updateStatus when the enable state flips on so the contents
		// appear without a full re-render.
		var state = this._runtimeState(status);
		// Basic mode hides the subscriptions/rules count and the
		// sing-box-version/network-mode footer — those signals are aimed at
		// power users debugging a config, not the Basic audience.
		var isBasic = (info.uiMode === 'basic');
		var rows = [
			E('div', {
				'style': 'display:flex; flex-wrap:wrap; align-items:center; ' +
				         'gap:0.7em; padding:0.2em 0; font-size:1.15em; line-height:1.3;'
			}, [
				E('span', { 'id': 'treadle-status-badge' }, [
					this._renderBadge(state)
				]),
				E('span', { 'style': 'opacity:0.6; font-weight:normal;' }, [
					_('via')
				]),
				// Advanced: inline default-node switcher. Basic: read-only
				// text — the server pick is a multi-select that lives on
				// the Basic tab, and the synthesised basic-auto tag is not
				// a thing the user should rebind from here.
				isBasic
					? E('strong', { 'id': 'treadle-active-node' }, [
						active || _('— no default')
					])
					: E('span', { 'id': 'treadle-active-node' }, [
						this._renderNodeSwitcher(info.tag)
					]),
				E('span', {
					'id': 'treadle-status-actions',
					'style': 'margin-left:auto; display:flex; gap:0.3em; font-size:0.88em;'
				}, this._renderActions(state))
			]),
			E('div', {
				'id': 'treadle-status-pausenote',
				'style': state === 'paused'
					? 'margin-top:0.4em; font-size:0.9em; opacity:0.7;'
					: 'display:none;'
			}, [ _('Paused for testing — will resume on next reboot.') ])
		];
		// Basic-mode first-run trap: service is enabled and running, but
		// no servers are picked. compute_default_outbound returns "direct"
		// so sing-box runs as a transparent forwarder and no traffic is
		// actually proxied — the user has no signal that nothing is
		// happening. Show an inline pointer to the Basic tab.
		if (isBasic && state === 'running' && !active) {
			rows.push(E('div', {
				'class': 'alert-message warning',
				'style': 'margin-top:0.6em;'
			}, [
				_('No server selected — open the '),
				this._tabLink('basic', _('Basic tab')),
				_(' and pick at least one server, otherwise traffic bypasses the proxy.')
			]));
		}
		if (!isBasic) {
			rows.push(E('div', { 'style': 'margin-top:0.5em;' }, [
				_('Subscriptions: %d').format(subCount),
				' · ',
				_('Active rules: %d').format(info.ruleCount)
			]));
			rows.push(E('div', {
				'id': 'treadle-status-footer',
				'style': 'margin-top:0.25em;'
			}, [
				this._renderFooter(status, mode)
			]));
		}
		return rows;
	},

	// ── Status controls + polling ─────────────────────────────────────────

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

	_updateStatus: function(status) {
		// Cached for _updateClashStats so the Traffic row stays hidden
		// whenever sing-box isn't actually running — the daemon snapshot
		// is a tmpfs file that doesn't clear when the service stops.
		this._running = !!status.running;

		// Reflect any out-of-band change to `enabled` (a CLI `uci set`, a
		// concurrent admin) into the checkbox state. Don't fire the click
		// handler — that would loop back into set_enabled.
		var cb = document.getElementById('treadle-enable-checkbox');
		if (cb) cb.checked = !!status.enabled;

		// Show/hide the runtime section as a whole. When flipping from
		// disabled→enabled, the section was previously hidden but its
		// inner DOM is still the stale snapshot from render(); rebuild it
		// from current values so the badge/actions/footer match.
		var runtime = document.getElementById('treadle-runtime-section');
		if (runtime) {
			if (status.enabled) {
				runtime.style.display = '';
				if (!document.getElementById('treadle-status-badge')) {
					var info     = runtimeInfo(this._outbounds);
					var active   = info.active;
					var mode     = uci.get('treadle', 'inbounds', 'mode') || 'tproxy';
					var subCount = uci.sections('treadle', 'subscription').length;
					while (runtime.firstChild) runtime.removeChild(runtime.firstChild);
					this._renderRuntime(status, active, subCount, info, mode)
						.forEach(function(n) { runtime.appendChild(n); });
					return;
				}
			} else {
				runtime.style.display = 'none';
				return;
			}
		}

		var state = this._runtimeState(status);

		var badge = document.getElementById('treadle-status-badge');
		if (badge) {
			while (badge.firstChild) badge.removeChild(badge.firstChild);
			badge.appendChild(this._renderBadge(state));
		}
		var actions = document.getElementById('treadle-status-actions');
		if (actions) {
			while (actions.firstChild) actions.removeChild(actions.firstChild);
			this._renderActions(state).forEach(function(b) {
				actions.appendChild(b);
			});
		}
		var pausenote = document.getElementById('treadle-status-pausenote');
		if (pausenote) {
			pausenote.style.display = (state === 'paused') ? '' : 'none';
			if (state === 'paused') {
				pausenote.style.marginTop = '0.4em';
				pausenote.style.fontSize  = '0.9em';
				pausenote.style.opacity   = '0.7';
			}
		}
		var footer = document.getElementById('treadle-status-footer');
		if (footer) {
			var mode2 = uci.get('treadle', 'inbounds', 'mode') || 'tproxy';
			footer.textContent = this._renderFooter(status, mode2);
		}
	},

	// Replace the Groups section's rows with the new snapshot. Hides the
	// whole section when the snapshot is empty so the page collapses
	// quietly back to the no-groups layout if the user deletes their last
	// group (or turns clash API off) without reloading the tab.
	_updateGroups: function(data) {
		var section = document.getElementById('treadle-groups-section');
		if (!section) return;
		var groups = (data && Array.isArray(data.groups)) ? data.groups : [];
		section.style.display = (groups.length > 0) ? '' : 'none';
		if (groups.length === 0) return;
		while (section.firstChild) section.removeChild(section.firstChild);
		this._renderGroups(data).forEach(function(n) {
			section.appendChild(n);
		});
	},

	// In-place refresh of the four (or five, with memory) traffic spans.
	// Re-renders the whole row only when the memory pill needs to appear
	// or disappear — adding/removing a sibling mid-row would otherwise
	// shift the others, and gating just that one span by display:none on
	// every tick is cheap. Hides the whole section when clash API was
	// disabled at runtime (Settings flipped while we were watching).
	_updateClashStats: function(stats) {
		var section = document.getElementById('treadle-traffic-section');
		if (!section) return;
		stats = stats || {};
		// Show only when the clash API is on AND sing-box is currently
		// up — a stale snapshot from a stopped sing-box is worse than
		// silence. `_running` is set by _updateStatus on each tick;
		// undefined on the first call (load() already gated the initial
		// render).
		if (stats.error || this._running === false) {
			section.style.display = 'none';
			return;
		}
		section.style.display = '';
		var memEl  = document.getElementById('treadle-traffic-mem');
		var wantMem = (typeof stats.mem_inuse === 'number' && stats.mem_inuse > 0);
		if (wantMem !== !!memEl) {
			while (section.firstChild) section.removeChild(section.firstChild);
			this._renderTraffic(stats).forEach(function(n) { section.appendChild(n); });
			return;
		}
		var set = function(id, text) {
			var el = document.getElementById(id);
			if (el) el.textContent = text;
		};
		set('treadle-traffic-down',     formatRate(stats.down_bps));
		set('treadle-traffic-up',       formatRate(stats.up_bps));
		set('treadle-traffic-conns',    String(stats.conn_count || 0));
		set('treadle-traffic-total-down', formatBytes(stats.total_down));
		set('treadle-traffic-total-up', formatBytes(stats.total_up));
		if (wantMem) set('treadle-traffic-mem', formatBytes(stats.mem_inuse));
	},

	_updateLogTail: function(data) {
		[['treadle-log-treadle', data.treadle],
		 ['treadle-log-singbox', data.singbox]].forEach(function(pair) {
			var el = document.getElementById(pair[0]);
			if (!el) return;
			el.value = formatLog(pair[1]);
			el.scrollTop = el.scrollHeight;
		});
	},

	// One poll tick: status badge/actions, groups and traffic, plus the two
	// log tails when they are due. One RPC, so one handler process on the
	// router per tick. Also called directly by the action handlers (with no
	// argument, so logs are included) so the page reflects a
	// start/stop/toggle immediately.
	_refreshStatusNow: function(logsDue) {
		var self = this;
		var withLogs = (logsDue !== false);
		// Omit `logs` rather than sending null: rpcd checks arguments against
		// the method's declared types, and `logs` is declared as a number.
		return callGetDashboard(withLogs ? TAIL_LINES : undefined).then(function(d) {
			d = d || {};
			self._updateStatus(d.status || {});
			self._updateGroups(d.groups || { groups: [] });
			self._updateClashStats(d.stats || {});
			if (withLogs)
				self._updateLogTail(d.logs || {});
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

	// ── Modals ────────────────────────────────────────────────────────────

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
	_teardown: function() {
		if (this._statusTimer) {
			clearTimeout(this._statusTimer);
			this._statusTimer = null;
		}
	},

	handleSave:      null,
	handleSaveApply: null,
	handleReset:     null
});
