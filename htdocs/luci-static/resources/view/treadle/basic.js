// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Basic tab. Shown only when treadle.global.mode = "basic"; the host view in
// main.js does the gating. The form binds to:
//
//   - treadle.subscription.*  — same UCI sections Advanced's Nodes tab uses, so
//                             subscriptions added here show up there.
//   - treadle.basic.server  — list of node tags the user selected; build-config's
//                             basic path turns N=1 into the final outbound and
//                             N>1 into a urltest tagged basic-auto.
//   - treadle.basic.routing — "all" | "bypass_country"
//   - treadle.basic.bypass_country — ISO code (curated list below)
//   - treadle.basic.ports   — "all" | "common"
//
// Custom rules, manual outbounds and /etc/treadle/extra.json are kept on disk
// but not compiled while in Basic mode; switching back to Advanced restores
// them.

'use strict';
'require baseclass';
'require form';
'require rpc';
'require uci';
'require view.treadle.lib.formpanel as formpanel';
'require view.treadle.lib.subs as subs';
'require view.treadle.lib.subsync as subsync';
'require view.treadle.uid as uid';

var callListOutbounds = rpc.declare({
	object: 'luci.treadle',
	method: 'list_outbounds',
	expect: { '': {} }
});

// Curated, alphabetical-by-English-name country list for the bypass picker.
// Power users who need an obscure code switch to Advanced mode.
var COUNTRIES = [
	['br', 'Brazil'], ['ca', 'Canada'], ['cn', 'China'], ['fr', 'France'],
	['de', 'Germany'], ['hk', 'Hong Kong'], ['in', 'India'], ['ir', 'Iran'],
	['it', 'Italy'], ['jp', 'Japan'], ['nl', 'Netherlands'], ['ru', 'Russia'],
	['sg', 'Singapore'], ['kr', 'South Korea'], ['es', 'Spain'], ['tw', 'Taiwan'],
	['tr', 'Turkey'], ['gb', 'United Kingdom'], ['us', 'United States']
];

return baseclass.extend({
	load: function() {
		// One UCI snapshot + one list_outbounds RPC covering every
		// subscription — one rpcd fork instead of one per subscription. The
		// host already loaded treadle; re-loading is cheap (cached) and keeps
		// the panel self-contained if it is ever mounted standalone.
		return uci.load('treadle').then(function() {
			// A hand-edited config may lack the `config treadle 'basic'`
			// section the shipped one has. Without it form.NamedSection
			// renders the section header but skips every option underneath.
			// set_mode recreates the section on the way into Basic; this
			// covers loading the panel directly.
			if (uci.get('treadle', 'basic') == null) {
				uci.add('treadle', 'treadle', 'basic');
			}
			// A failed RPC degrades to an empty picker (the Server field
			// then shows its "No nodes yet" hint) rather than killing the
			// tab.
			return callListOutbounds().catch(function() { return {}; });
		}).then(function(res) {
			// Keep subscription nodes only (manual nodes are an Advanced
			// concept), and filter group types out: clash-format
			// subscriptions may carry urltest groups alongside individual
			// nodes, and Basic's "pick N, auto-wrap in basic-auto" flow
			// only makes sense for concrete servers — wrapping a group
			// inside another group is valid in sing-box but confusing in a
			// "Default server(s)" picker.
			var GROUP_TYPES = { urltest: true };
			var subName = subs.nameMap();
			var nodes = [];
			// luci.jsonc serialises an empty Lua array as `{}`, so an
			// empty outbound list arrives as an object, not []. Coerce
			// defensively so the .forEach doesn't blow up the tab on a
			// fresh install with no subscriptions synced yet.
			var rawOut = (res || {}).outbounds;
			(Array.isArray(rawOut) ? rawOut : []).forEach(function(ob) {
				if (ob.tag && ob.subscription && !GROUP_TYPES[ob.type])
					nodes.push({
						tag:      ob.tag,
						sub_id:   ob.subscription,
						sub_name: subName[ob.subscription] || ob.subscription
					});
			});
			return nodes;
		});
	},

	render: function(nodes) {
		var self = this;
		nodes = nodes || [];

		var m = new form.Map('treadle');

		// ── Subscriptions ───────────────────────────────────────────────
		// Minimal columns vs. Advanced's Nodes tab — no auto-update / UA /
		// last-sync clutter. Same UCI sections, so anything added here is
		// visible from Advanced too.
		var sSubs = m.section(form.GridSection, 'subscription', _('Subscriptions'),
			_('Lists of nodes Treadle downloads on a schedule.'));
		sSubs.addremove   = true;
		sSubs.anonymous   = true;
		sSubs.addbtntitle = _('Add subscription');
		sSubs.modaltitle  = function() { return _('Subscription'); };

		// Create every subscription as a NAMED section whose name is a
		// random 16-hex uid — same scheme as the Advanced Nodes panel.
		// /etc/treadle/nodes/<uid>.json is keyed by that name.
		uid.installGridAdd(sSubs);

		var oSubEnabled = sSubs.option(form.Flag, 'enabled', _('Enabled'));
		oSubEnabled["default"] = '1';
		oSubEnabled.rmempty    = false;
		oSubEnabled.editable   = true;

		var oSubName = sSubs.option(form.Value, 'name', _('Name'));
		oSubName.rmempty     = false;
		oSubName.placeholder = _('My subscription');

		var oSubCount = sSubs.option(form.DummyValue, 'node_count', _('Nodes'));
		oSubCount.modalonly = false;

		var oSubUrl = sSubs.option(form.Value, 'url', _('URL'));
		oSubUrl.modalonly    = true;
		oSubUrl.rmempty      = false;
		oSubUrl.placeholder  = 'https://example.com/sub';

		// Silent 12h auto-refresh for any subscription created from Basic.
		// sync-subscriptions skips subs with auto_update unset or 0, so without
		// this default a Basic user would never get an automatic refresh — they
		// would have to switch to Advanced and toggle it on, which defeats the
		// "set it and forget it" promise. HiddenValue keeps the UI sparse;
		// rmempty=false so the explicit '12' lands in UCI (rmempty=true would
		// let LuCI drop the option when value == default, oscillating with the
		// cron path). Existing subs imported from Advanced keep their saved
		// value untouched.
		var oSubAuto = sSubs.option(form.HiddenValue, 'auto_update');
		oSubAuto["default"] = '12';
		oSubAuto.rmempty    = false;
		oSubAuto.modalonly  = true;

		var oSubSync = sSubs.option(form.Button, '_sync', _('Sync'));
		oSubSync.modalonly  = false;
		oSubSync.editable   = true;
		oSubSync.inputtitle = _('Sync');
		oSubSync.inputstyle = 'apply';
		oSubSync.onclick = function(ev, section_id) {
			return subsync.handleSync(self, ev, section_id);
		};

		// ── Default server(s) ───────────────────────────────────────────
		// All Basic-mode knobs share the treadle.basic NamedSection. They are
		// split into three visual sections for readability.
		var sServer = m.section(form.NamedSection, 'basic', 'treadle',
			_('Default server(s)'),
			_('Pick one server, or several. With several, sing-box auto-routes through whichever has the lowest latency.'));
		sServer.addremove = false;

		var oServer = sServer.option(form.MultiValue, 'server', _('Server'));
		// 'select' renders LuCI's checkbox-multi-select dropdown — same widget
		// Advanced's urltest member picker uses, with a search field for long
		// node lists.
		oServer.widget = 'select';
		// transformChoices() returns null when no .value() entries exist (a
		// fresh install with nothing synced); ui.Dropdown's null check uses
		// `typeof`, which null passes, so Object.keys(null) then kills the
		// whole tab. Coerce to {} for an empty-but-rendering dropdown.
		oServer.transformChoices = function() {
			return form.MultiValue.prototype.transformChoices.apply(this) || {};
		};
		oServer.rmempty = true;
		oServer.placeholder = _('— pick one or more —');
		if (nodes.length === 0) {
			oServer.description = _('No nodes yet. Add a subscription and sync it first.');
		} else {
			nodes.forEach(function(n) {
				oServer.value(n.tag, n.tag + '  (' + n.sub_name + ')');
			});
		}

		// ── Routing ─────────────────────────────────────────────────────
		var sRouting = m.section(form.NamedSection, 'basic', 'treadle', _('Routing'));
		sRouting.addremove = false;

		var oRouting = sRouting.option(form.ListValue, 'routing', _('Mode'));
		oRouting.value('all',            _('Proxy everything'));
		oRouting.value('bypass_country', _('Proxy everything except this country'));
		oRouting["default"] = 'all';

		var oCountry = sRouting.option(form.ListValue, 'bypass_country', _('Country to bypass'));
		COUNTRIES.forEach(function(c) { oCountry.value(c[0], _(c[1])); });
		oCountry["default"] = 'cn';
		oCountry.depends('routing', 'bypass_country');

		// ── Ports ───────────────────────────────────────────────────────
		var sPorts = m.section(form.NamedSection, 'basic', 'treadle', _('Ports'));
		sPorts.addremove = false;

		var oPorts = sPorts.option(form.ListValue, 'ports', _('Mode'));
		oPorts.value('all',    _('Proxy all ports'));
		oPorts.value('common', _('Proxy only common ports (SSH, mail, DNS, web, messengers)'));
		oPorts["default"] = 'all';

		// Surface the single Advanced flag worth exposing in Basic: the
		// clash API drives the Status panel's Traffic row and the per-group
		// active-node display. Without this control, a user who enabled it
		// in Advanced and then switched to Basic would have no way to turn
		// it off (Settings tab is hidden). Bound to treadle.global like the
		// Advanced version, so toggling in either mode shows the other.
		var sStats = m.section(form.NamedSection, 'global', 'treadle', _('Status panel'));
		sStats.addremove = false;
		var oClash = sStats.option(form.Flag, 'clash_api_enabled',
			_('Show traffic and active-node stats'),
			_('Adds a loopback-only listener to sing-box (127.0.0.1:9090, ' +
			  'never on the LAN) so the Status panel can display live ' +
			  'throughput and which proxy node is currently active.'));
		oClash.rmempty = false;

		this.map = m;
		return m.render().then(L.bind(this._postRender, this));
	},

	// Append the bottom-of-panel "Switch to Advanced mode" link below the
	// form, before the host's footer attaches.
	_postRender: function(formNode) {
		var self = this;

		// Breathing room between sections — the four Basic stacks
		// (Subscriptions / Default server(s) / Routing / Ports) sit on top
		// of each other with the LuCI default 0.5em gap, which reads as one
		// dense block. 2em margin-top on every .cbi-section pushes each
		// title down so the visual rhythm matches the conceptual grouping.
		// Scoped to .cbi-map.treadle-basic to leave Advanced layouts alone.
		formNode.classList.add('treadle-basic');
		formNode.appendChild(E('style', {}, [
			'.cbi-map.treadle-basic .cbi-section{margin-top:2em}'
		]));

		formNode.appendChild(E('div', {
			'class': 'cbi-section',
			'style': 'margin-top:1em; text-align:right; font-size:0.9em'
		}, [
			_('Need more control? '),
			E('a', {
				'href':  '#',
				'click': function(ev) {
					ev.preventDefault();
					self._switchToAdvanced();
				}
			}, [ _('Switch to Advanced mode →') ])
		]));
		return formNode;
	},

	_switchToAdvanced: function() {
		// Delegate to the host: main.js owns set_mode plus the
		// unsaved-changes warning and the staged-changes revert step.
		// _treadleHost is set by main.js _activate when the panel mounts.
		if (this._treadleHost && typeof this._treadleHost._handleModeSwitch === 'function') {
			return this._treadleHost._handleModeSwitch('advanced');
		}
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	// GridSection edits are flushed to staging when their modal saves, so the
	// panel-level Reset must revert via ui.changes.revert() (see formpanel).
	handleReset:     function() { return formpanel.resetGrid(this); }
});
