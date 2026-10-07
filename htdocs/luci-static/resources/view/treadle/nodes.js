// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Nodes tab: subscriptions on top, manually-configured nodes below.
// "Node" is the user-facing noun for what sing-box calls an outbound — it
// covers both individual servers and urltest group outbounds. The UCI section
// names (`node`, `subscription`) and the RPC method names (list_outbounds)
// use sing-box's vocabulary.
// Both sections share one form.Map('treadle') so a single Save & Apply commits
// edits to both — they already share the same UCI config and the same global
// revert (formpanel.resetGrid calls ui.changes.revert), so a unified footer is
// the natural UX.

'use strict';
'require baseclass';
'require form';
'require ui';
'require uci';
'require rpc';
'require dom';
'require view.treadle.lib.ordersave as ordersave';
'require view.treadle.lib.formpanel as formpanel';
'require view.treadle.lib.subs as subs';
'require view.treadle.lib.badges as badges';
'require view.treadle.lib.subsync as subsync';
'require view.treadle.lib.notify as notify';
'require view.treadle.uid as uid';

var callListSubscriptionNodes = rpc.declare({
	object: 'luci.treadle',
	method: 'list_subscription_nodes',
	params: ['id'],
	expect: { '': {} }
});

var callListOutbounds = rpc.declare({
	object: 'luci.treadle',
	method: 'list_outbounds',
	expect: { '': {} }
});

var callParseNodeLink = rpc.declare({
	object: 'luci.treadle',
	method: 'parse_node_link',
	params: ['link'],
	expect: { '': {} }
});

var callGetLastLatency = rpc.declare({
	object: 'luci.treadle',
	method: 'get_last_latency',
	expect: { '': {} }
});

// Background-runner RPCs — every latency probe (per-row Test, "Test all",
// per-subscription batch) goes through them: test_all_start forks the
// runner and returns immediately (no XHR-timeout issue — the heavy lifting
// is fire-and-forget on the device); the runner spins up an ephemeral
// sing-box probe instance containing every known node, so nodes absent
// from the lean running config are testable too. test_all_status reads
// the runner's tiny progress file. UI polls the status while refreshing
// cells from get_last_latency between ticks, so results appear as the
// runner writes them.
var callTestAllStart = rpc.declare({
	object: 'luci.treadle',
	method: 'test_all_start',
	params: ['tags'],
	expect: { '': {} }
});

// The Status tab's batch call, read here without logs: subscription ages
// from the router's clock, and each group's live members and current pick
// (active-watch's snapshot; empty when live stats are off).
var callGetDashboard = rpc.declare({
	object: 'luci.treadle',
	method: 'get_dashboard',
	expect: { '': {} }
});

var callTestAllStatus = rpc.declare({
	object: 'luci.treadle',
	method: 'test_all_status',
	expect: { '': {} }
});


// Color-coded latency badge shared with the Status panel — lives in
// lib/badges.js so the two columns agree on what 'yellow' means.
var formatLatency = badges.formatLatency;

// Same red as lib/badges.js: Bootstrap has no red label class.
var DANGER_STYLE =
	' background-color: var(--danger-color, var(--error-color, var(--error-color-high, #d9534f)));' +
	' color: var(--on-danger-color, var(--on-error-color, #fff));';

// "93 s" / "12 min" / "5 h" / "9 d": an age in seconds, coarse on purpose.
function formatAge(sec) {
	sec = Number(sec);
	if (!(sec >= 0)) return '';
	if (sec < 60)    return _('%d s').format(sec);
	if (sec < 3600)  return _('%d min').format(Math.floor(sec / 60));
	if (sec < 86400) return _('%d h').format(Math.floor(sec / 3600));
	return _('%d d').format(Math.floor(sec / 86400));
}


// Types with a server endpoint. `direct` is excluded — a direct outbound has
// no server field (build-config drops it); it is just an optional override.
var SERVER_TYPES    = ['vless','vmess','trojan','shadowsocks','hysteria2','tuic','anytls','wireguard','socks'];
// AnyTLS is not here: sing-box's anytls outbound has no transport field.
var TRANSPORT_TYPES = ['vless','vmess','trojan'];

// Add one depends() clause per accepted value (LuCI ORs separate calls).
// `extra` keys are ANDed into every clause.
function depAny(o, field, values, extra) {
	values.forEach(function(v) {
		var d = {};
		d[field] = v;
		if (extra)
			for (var k in extra) d[k] = extra[k];
		o.depends(d);
	});
}

return baseclass.extend({
	load: function() {
		// A failed list_outbounds or get_last_latency must not kill the tab
		// — degrade to an empty list / empty cache instead.
		return Promise.all([
			uci.load('treadle'),
			callListOutbounds().catch(function() { return {}; }),
			callGetLastLatency().catch(function() { return { results: {} }; }),
			callGetDashboard().catch(function() { return {}; })
		]);
	},

	render: function(data) {
		var self = this;
		var m = new form.Map('treadle');

		// Latency cache: { tag → { delay_ms?, error?, tested_at } }. The
		// formatLatency helper reads from here on every grid render and
		// _refreshLatencyCells writes into it after each probe. Stored on
		// `this` so the per-row Test handlers can mutate it.
		this._latency = ((data && data[2] && data[2].results) || {});

		// tag → [ live <span> elements that should reflect this tag's
		// latency ]. Built up as cells render, drained when stale (DOM
		// disconnected). Used instead of a querySelectorAll on a
		// data-attribute, because tag values include emoji (🇭🇰, 🇯🇵, …) and
		// CSS attribute selector escapes for surrogate-pair characters are
		// not portable across browsers — the old code threw a SyntaxError
		// on the first emoji tag and broke the whole batch promise.
		this._latencyCells = {};

		// Live data for the Groups and Subscriptions columns.
		var dash = (data && data[3]) || {};
		this._subAge = {};
		(Array.isArray(dash.subs) ? dash.subs : []).forEach(function(a) {
			self._subAge[a.id] = a;
		});
		this._liveGroup = {};
		var lg = dash.groups && Array.isArray(dash.groups.groups) ? dash.groups.groups : [];
		lg.forEach(function(g) { self._liveGroup[g.tag] = g; });

		var outbounds = (data && data[1] && Array.isArray(data[1].outbounds))
			? data[1].outbounds : [];
		// Used by _collectAllTags to drive "Test all".
		this._outbounds = outbounds;
		var memberList = this._memberList(outbounds);

		this._renderSubscriptions(m);
		this._renderGroups(m, memberList);
		this._renderNodes(m, memberList);

		this.map = m;
		ordersave.install(m, 'subscription');
		ordersave.install(m, 'node');

		return m.render().then(function(node) {
			// "Test all" sits next to the Subscriptions section's Add button
			// so it is visible without scrolling past a long node list. The
			// first .cbi-section-create in document order is the
			// subscriptions one since that section renders first.
			var clashOn = (uci.get('treadle', 'global', 'clash_api_enabled') === '1');
			var subsCreate = node.querySelector('.cbi-section-create');
			if (subsCreate && clashOn) {
				self._testAllBtn = E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'style': 'margin-left:0.4em',
					'click': ui.createHandlerFn(self, '_testAll')
				}, [ _('Test all') ]);
				subsCreate.appendChild(self._testAllBtn);
			}
			// Breathing room between the sections — matches the gap between
			// sibling sections on the stock DHCP page. Groups and manual
			// nodes are both `node` sections, so they share an element id;
			// select them by it as a list.
			var nodeSections = node.querySelectorAll('[id="cbi-treadle-node"]');
			for (var i = 0; i < nodeSections.length; i++)
				nodeSections[i].style.marginTop = '2em';
			var creates = node.querySelectorAll('.cbi-section-create');
			var nodesCreate = creates[creates.length - 1];
			if (nodesCreate)
				nodesCreate.appendChild(E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'style': 'margin-left:0.4em',
					'click': ui.createHandlerFn(self, '_addFromLink')
				}, [ _('Add from link…') ]));
			// A runner may already be in flight when this tab renders —
			// the post-first-sync test forked by sync_subscription, or a
			// Test all surviving the tab reload a sync triggers. Resume
			// the progress poll so its results land in the cells.
			if (clashOn)
				self._resumeTestPoll();
			return node;
		});
	},

	_renderSubscriptions: function(m) {
		var self = this;

		var s = m.section(form.GridSection, 'subscription', _('Subscriptions'),
			_('Lists of nodes Treadle downloads on a schedule.'));
		s.addremove = true;
		s.sortable  = true;
		s.anonymous = true;
		s.addbtntitle = _('Add subscription');
		s.modaltitle = function() { return _('Subscription'); };

		// Create every subscription as a NAMED section whose name is a
		// random 16-hex uid. That name is the stable id used by everything
		// downstream — the on-disk file at /etc/treadle/nodes/<uid>.json, the
		// `subscription` field on outbounds, and the `urltest_regex_sources`
		// allowlist. Anonymous sections would pick up libuci's volatile
		// cfgXXXX (regenerated from a package-wide counter on every parse,
		// shifted by any structural change to /etc/config/treadle); the named
		// form is fixed from creation through commit.
		uid.installGridAdd(s);
		formpanel.deleteInModal(s);

		var oName = s.option(form.Value, 'name', _('Name'));
		oName.rmempty = false;
		oName.placeholder = _('My Subscription');

		// Read-only grid columns — modalonly=false keeps them out of the edit
		// modal. The node count is also the way into the node list.
		var oCount = s.option(form.DummyValue, 'node_count', _('Nodes'));
		oCount.modalonly = false;
		// editable: grid cells render the element instead of escaping it.
		oCount.editable = true;
		oCount.cfgvalue = function(section_id) {
			var n = parseInt(uci.get('treadle', section_id, 'node_count'), 10) || 0;
			return E('a', {
				'href': '#',
				'title': _('View the nodes in this subscription'),
				'click': function(ev) {
					ev.preventDefault();
					self._showNodes(section_id);
				}
			}, [ _('%d nodes').format(n) ]);
		};

		var oLast = s.option(form.DummyValue, '_last_sync', _('Last sync'));
		oLast.modalonly = false;
		// editable: grid cells render the element instead of escaping it.
		oLast.editable = true;
		oLast.cfgvalue = function(section_id) {
			var a = self._subAge[section_id] || {};
			var exact = uci.get('treadle', section_id, 'last_ok')
				|| uci.get('treadle', section_id, 'last_sync') || '';
			return E('span', { 'title': exact }, [
				(a.ok_age_s != null) ? _('%s ago').format(formatAge(a.ok_age_s)) : _('never')
			]);
		};

		var oState = s.option(form.DummyValue, '_state', _('State'));
		oState.modalonly = false;
		// editable: grid cells render the element instead of escaping it.
		oState.editable = true;
		oState.cfgvalue = function(section_id) {
			return self._subState(section_id);
		};

		var oUrl = s.option(form.Value, 'url', _('URL'));
		oUrl.modalonly = true;
		oUrl.rmempty = false;
		oUrl.placeholder = 'https://example.com/sub';

		var oAuto = s.option(form.Value, 'auto_update', _('Auto-update (hours)'),
			_('0 disables periodic refresh.'));
		oAuto.modalonly = true;
		oAuto.datatype = 'uinteger';
		oAuto['default'] = '0';

		var oUA = s.option(form.Value, 'user_agent', _('User-Agent'));
		oUA.modalonly = true;
		oUA.placeholder = _('sing-box/<installed version>');

		var oSync = s.option(form.Button, '_sync', _('Sync'));
		oSync.modalonly = false;
		oSync.editable = true;
		oSync.inputtitle = _('Sync');
		oSync.inputstyle = 'apply';
		oSync.onclick = function(ev, section_id) {
			return subsync.handleSync(self, ev, section_id);
		};
	},

	// Ask for one share link, parse it on the router, and open the node
	// editor on a new node pre-filled from it. Nothing is written until the
	// user saves the editor, and Dismiss removes the staged node again —
	// the same lifecycle as the Add button's.
	_addFromLink: function() {
		var self = this;
		var input = E('textarea', {
			'class': 'cbi-input-textarea',
			'rows': 4,
			'style': 'width:100%; font-family:monospace; word-break:break-all;',
			'placeholder': 'vless://…'
		});
		var err = E('div');
		ui.showModal(_('Add node from link'), [
			E('p', {}, [ _('Paste one share link: vless, vmess, trojan, ss, hysteria2, tuic, anytls or socks.') ]),
			input,
			err,
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button cbi-button-neutral', 'click': ui.hideModal },
					[ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(self, function(ev) {
						var link = input.value.trim();
						if (!link)
							return;
						return callParseNodeLink(link).then(function(r) {
							if (!r || r.error || !r.fields) {
								dom.content(err, E('div', { 'class': 'alert-message warning' },
									[ (r && r.error) || _('Not a recognised share link.') ]));
								return;
							}
							return self._openImported(ev, r.fields,
								Array.isArray(r.dropped) ? r.dropped : []);
						});
					})
				}, [ _('Continue') ])
			])
		]);
		input.focus();
	},

	_openImported: function(ev, fields, dropped) {
		var s = this._nodeSection;
		var sid = uid.generate();
		// handleAdd stages the section synchronously and reads its values
		// only once the modal map renders, so fields set straight after it
		// returns are what the editor opens with.
		var opened = s.handleAdd(ev, sid);
		for (var k in fields)
			uci.set('treadle', sid, k, fields[k]);
		return Promise.resolve(opened).then(function() {
			if (!dropped.length)
				return;
			var modal = document.querySelector('#modal_overlay .modal');
			var msg = _('Not carried over from the link: %s').format(dropped.join(', '));
			if (modal && modal.firstChild)
				modal.insertBefore(E('div', { 'class': 'alert-message warning' }, [ msg ]),
					modal.firstChild.nextSibling);
			else
				notify.warning(msg);
		});
	},

	// Manual nodes: everything of type `node` that is not a group.
	_renderNodes: function(m, memberList) {
		var self = this;

		var s = m.section(form.GridSection, 'node', _('Manual nodes'),
			_('Nodes you add by hand, from a share link or field by field.'));
		s.filter = function(section_id) {
			return uci.get('treadle', section_id, 'type') !== 'urltest';
		};
		s.addremove = true;
		s.sortable  = true;
		s.anonymous = true;
		s.addbtntitle = _('Add node');
		s.modaltitle = function() { return _('Node'); };

		// Same uid-as-section-name pattern as the subscriptions section
		// above. Manual nodes are cross-referenced by `tag`, but creating
		// them as named sections keeps the schema uniform with every other
		// anonymous type and forecloses any future code that might reach
		// for the section id as a cross-reference.
		uid.installGridAdd(s);
		formpanel.deleteInModal(s);
		this._nodeSection = s;

		s.tab('general',   _('General'));
		s.tab('transport', _('Transport'));
		s.tab('tls',       _('TLS'));

		var o;

		// ── General: identity + protocol credentials ────────────────────
		// ListValue options below intentionally carry no `default`: the
		// first value() entry is the implicit default, so the field is
		// written once on create but not re-written on an unchanged save
		// (which would register a phantom UCI change).
		this._tagOption(s, 'general');

		var oType = s.taboption('general', form.ListValue, 'type', _('Type'));
		oType.modalonly = true;
		[['vless','VLESS'],['vmess','VMess'],['trojan','Trojan'],
		 ['shadowsocks','Shadowsocks'],['hysteria2','Hysteria2'],['tuic','TUIC'],
		 ['anytls','AnyTLS'],['wireguard','WireGuard'],['socks','SOCKS5'],
		 ['direct','Direct']].forEach(function(t) {
			oType.value(t[0], t[1]);
		});

		// Grid-only summaries: the protocol with what matters about how it
		// connects, and where it connects to.
		var oProto = s.taboption('general', form.DummyValue, '_proto', _('Protocol'));
		oProto.modalonly = false;
		oProto.cfgvalue = function(section_id) {
			var get = function(k) { return uci.get('treadle', section_id, k); };
			var parts = [ oType.keylist.indexOf(get('type')) >= 0
				? oType.vallist[oType.keylist.indexOf(get('type'))] : (get('type') || '?') ];
			if (get('tls_reality') === '1') parts.push('REALITY');
			else if (get('tls_enabled') === '1') parts.push('TLS');
			if (get('transport_type')) parts.push(String(get('transport_type')).toUpperCase());
			return parts.join(' · ');
		};
		var oServer = s.taboption('general', form.DummyValue, '_server', _('Server'));
		oServer.modalonly = false;
		oServer.cfgvalue = function(section_id) {
			var host = uci.get('treadle', section_id, 'server');
			var port = uci.get('treadle', section_id, 'server_port');
			if (!host) return '—';
			return (host.indexOf(':') >= 0 ? '[' + host + ']' : host) + (port ? ':' + port : '');
		};

		// ── Latency + Test (grid-only) ───────────────────────────────────
		// Both columns appear only when latency testing is enabled
		// (clash_api_enabled); otherwise the Test button would just emit a
		// "clash API disabled" notification on every click. Reading the
		// UCI flag from the loaded treadle config (load() already pulled it
		// in) keeps this synchronous.
		var clashOn = (uci.get('treadle', 'global', 'clash_api_enabled') === '1');
		if (clashOn) {
			var oLatency = s.taboption('general', form.DummyValue, '_latency',
				_('Latency'));
			oLatency.modalonly = false;
			oLatency.editable  = true;
			// cfgvalue gets the section_id of the row — look up its tag in
			// UCI, then the cached probe result for that tag. The cell is
			// registered with _registerLatencyCell so _refreshLatencyCell
			// can update it later without re-rendering the whole grid.
			oLatency.cfgvalue = function(section_id) {
				var tag = uci.get('treadle', section_id, 'tag') || '';
				var span = E('span', {}, [ formatLatency(self._latency[tag]) ]);
				self._registerLatencyCell(tag, span);
				return span;
			};

			var oTest = s.taboption('general', form.Button, '_test',
				_('Test'));
			oTest.modalonly  = false;
			oTest.editable   = true;
			oTest.inputtitle = _('Test');
			oTest.inputstyle = 'neutral';
			oTest.onclick    = function(ev, section_id) {
				var tag = uci.get('treadle', section_id, 'tag') || '';
				if (!tag) return;
				return self._testOne(ev.currentTarget, tag);
			};
		}

		o = s.taboption('general', form.Value, 'server', _('Server'));
		o.modalonly = true;
		o.placeholder = _('hostname or IP');
		depAny(o, 'type', SERVER_TYPES);

		o = s.taboption('general', form.Value, 'server_port', _('Port'));
		o.modalonly = true;
		o.datatype = 'port';
		o.placeholder = '443';
		depAny(o, 'type', SERVER_TYPES);

		o = s.taboption('general', form.Value, 'uuid', _('UUID'));
		o.modalonly = true;
		depAny(o, 'type', ['vless','vmess','tuic']);

		o = s.taboption('general', form.Value, 'password', _('Password'));
		o.modalonly = true;
		o.password = true;
		depAny(o, 'type', ['trojan','shadowsocks','hysteria2','tuic','anytls','socks']);

		o = s.taboption('general', form.ListValue, 'security', _('Security'));
		['auto','aes-128-gcm','chacha20-poly1305','none','zero'].forEach(function(v) {
			o.value(v, v);
		});
		o.modalonly = true;
		o.depends('type', 'vmess');

		o = s.taboption('general', form.Value, 'alter_id', _('Alter ID'));
		o.modalonly = true;
		o.datatype = 'uinteger';
		o.placeholder = '0';
		o.depends('type', 'vmess');

		o = s.taboption('general', form.ListValue, 'flow', _('Flow'));
		o.value('', _('None'));
		o.value('xtls-rprx-vision', 'xtls-rprx-vision');
		o.modalonly = true;
		o.optional = true;
		o.depends('type', 'vless');

		o = s.taboption('general', form.ListValue, 'method', _('Method'));
		['aes-256-gcm','aes-128-gcm','chacha20-ietf-poly1305','2022-blake3-aes-128-gcm',
		 '2022-blake3-aes-256-gcm','2022-blake3-chacha20-poly1305'].forEach(function(v) {
			o.value(v, v);
		});
		o.modalonly = true;
		o.depends('type', 'shadowsocks');

		o = s.taboption('general', form.Value, 'username', _('Username'));
		o.modalonly = true;
		o.depends('type', 'socks');

		o = s.taboption('general', form.Flag, 'udp_over_tcp', _('UDP over TCP'),
			_('Only for servers that support it, such as sing-box ones.'));
		o.modalonly = true;
		depAny(o, 'type', ['shadowsocks','socks']);

		o = s.taboption('general', form.ListValue, 'packet_encoding', _('Packet encoding'));
		o.value('', _('Default'));
		o.value('xudp', 'xudp');
		o.value('packetaddr', 'packetaddr');
		o.modalonly = true;
		o.optional = true;
		depAny(o, 'type', ['vless','vmess']);

		o = s.taboption('general', form.ListValue, 'obfs_type', _('Obfuscation'));
		o.value('', _('None'));
		o.value('salamander', 'salamander');
		o.modalonly = true;
		o.optional = true;
		o.depends('type', 'hysteria2');

		o = s.taboption('general', form.Value, 'obfs_password', _('Obfs password'));
		o.modalonly = true;
		o.password = true;
		o.depends({ type: 'hysteria2', obfs_type: 'salamander' });

		o = s.taboption('general', form.DynamicList, 'hy2_server_ports', _('Port hopping'),
			_('Port ranges as <code>first:last</code>; the client hops between ports in them.'));
		o.modalonly = true;
		o.placeholder = '20000:30000';
		o.validate = function(section_id, value) {
			var m = /^(\d+):(\d+)$/.exec(value);
			if (!value || (m && +m[1] >= 1 && +m[1] <= +m[2] && +m[2] <= 65535))
				return true;
			return _('Expecting a range first:last within 1-65535');
		};
		o.depends('type', 'hysteria2');

		o = s.taboption('general', form.Value, 'hy2_hop_interval', _('Hop interval'));
		o.modalonly = true;
		o.placeholder = '30s';
		o.validate = function(section_id, value) {
			return (!value || /^(\d+(\.\d+)?(ns|us|ms|s|m|h))+$/.test(value))
				? true : _('Expecting a duration such as 30s or 1m');
		};
		o.depends('type', 'hysteria2');

		o = s.taboption('general', form.Value, 'hy2_up_mbps', _('Upload (Mbps)'),
			_('Leave both empty to let the server negotiate.'));
		o.modalonly = true;
		o.datatype = 'uinteger';
		o.depends('type', 'hysteria2');

		o = s.taboption('general', form.Value, 'hy2_down_mbps', _('Download (Mbps)'));
		o.modalonly = true;
		o.datatype = 'uinteger';
		o.depends('type', 'hysteria2');

		o = s.taboption('general', form.ListValue, 'congestion_control', _('Congestion'));
		['cubic','new_reno','bbr'].forEach(function(v) { o.value(v, v); });
		o.modalonly = true;
		o.depends('type', 'tuic');

		o = s.taboption('general', form.ListValue, 'udp_relay_mode', _('UDP relay'));
		o.value('', _('Default'));
		o.value('native', 'native');
		o.value('quic', 'quic');
		o.modalonly = true;
		o.optional = true;
		o.depends('type', 'tuic');

		o = s.taboption('general', form.Value, 'override_address', _('Override address'));
		o.modalonly = true;
		o.depends('type', 'direct');

		o = s.taboption('general', form.Value, 'override_port', _('Override port'));
		o.modalonly = true;
		o.datatype = 'port';
		o.depends('type', 'direct');

		// ── WireGuard ───────────────────────────────────────────────────
		o = s.taboption('general', form.Value, 'wg_local_address', _('Local address'));
		o.modalonly = true;
		o.placeholder = '10.0.0.2/32';
		o.depends('type', 'wireguard');

		o = s.taboption('general', form.Value, 'wg_private_key', _('Private key'));
		o.modalonly = true;
		o.password = true;
		o.depends('type', 'wireguard');

		o = s.taboption('general', form.Value, 'wg_peer_public_key', _('Peer public key'));
		o.modalonly = true;
		o.depends('type', 'wireguard');

		o = s.taboption('general', form.Value, 'wg_preshared_key', _('Pre-shared key'));
		o.modalonly = true;
		o.password = true;
		o.depends('type', 'wireguard');

		o = s.taboption('general', form.Value, 'wg_mtu', _('MTU'));
		o.modalonly = true;
		o.datatype = 'uinteger';
		o.placeholder = '1408';
		o.depends('type', 'wireguard');

		// ── Transport ───────────────────────────────────────────────────
		o = s.taboption('transport', form.ListValue, 'transport_type', _('Transport'));
		o.value('', _('None'));
		o.value('ws',   'WebSocket');
		o.value('grpc', 'gRPC');
		o.value('http', 'HTTP/2');
		o.value('httpupgrade', 'HTTPUpgrade');
		o.value('xhttp', _('XHTTP (stream-one)'));
		o.modalonly = true;
		o.optional = true;
		depAny(o, 'type', TRANSPORT_TYPES);

		o = s.taboption('transport', form.Value, 'transport_ws_path', _('WS path'));
		o.modalonly = true;
		o.placeholder = '/';
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'ws' });

		o = s.taboption('transport', form.Value, 'transport_ws_host', _('WS host header'));
		o.modalonly = true;
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'ws' });

		o = s.taboption('transport', form.Value, 'transport_ws_max_early_data', _('WS early data'),
			_('Bytes of the first payload sent with the handshake. Empty or 0 disables.'));
		o.modalonly = true;
		o.datatype = 'uinteger';
		o.placeholder = '2048';
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'ws' });

		o = s.taboption('transport', form.Value, 'transport_ws_early_data_header', _('WS early data header'),
			_('Empty sends early data in the path; Xray servers expect Sec-WebSocket-Protocol.'));
		o.modalonly = true;
		o.placeholder = 'Sec-WebSocket-Protocol';
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'ws' });

		o = s.taboption('transport', form.Value, 'transport_grpc_service', _('gRPC service'));
		o.modalonly = true;
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'grpc' });

		o = s.taboption('transport', form.Value, 'transport_http_path', _('HTTP path'));
		o.modalonly = true;
		o.placeholder = '/';
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'http' });

		o = s.taboption('transport', form.Value, 'transport_http_host', _('HTTP host'),
			_('Separate several hosts with commas.'));
		o.modalonly = true;
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'http' });

		o = s.taboption('transport', form.Value, 'transport_httpupgrade_path', _('HTTPUpgrade path'));
		o.modalonly = true;
		o.placeholder = '/';
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'httpupgrade' });

		o = s.taboption('transport', form.Value, 'transport_httpupgrade_host', _('HTTPUpgrade host'));
		o.modalonly = true;
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'httpupgrade' });

		// XHTTP is Xray's transport; only its stream-one mode has the wire
		// shape of sing-box's `http` transport, which build-config maps it
		// onto. packet-up and stream-up servers cannot be reached.
		o = s.taboption('transport', form.Value, 'transport_xhttp_path', _('XHTTP path'),
			_('Only servers that accept stream-one mode work.'));
		o.modalonly = true;
		o.placeholder = '/';
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'xhttp' });

		o = s.taboption('transport', form.Value, 'transport_xhttp_host', _('XHTTP host'));
		o.modalonly = true;
		o.placeholder = _('SNI, or the server address');
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'xhttp' });

		// ── TLS ─────────────────────────────────────────────────────────
		o = s.taboption('tls', form.Flag, 'tls_enabled', _('TLS'));
		o.modalonly = true;
		depAny(o, 'type', ['vless','vmess']);

		var oSni = s.taboption('tls', form.Value, 'tls_sni', _('SNI'));
		oSni.modalonly = true;
		oSni.placeholder = _('e.g. example.com');

		var oInsec = s.taboption('tls', form.Flag, 'tls_insecure', _('Allow insecure'));
		oInsec.modalonly = true;

		var oAlpn = s.taboption('tls', form.DynamicList, 'tls_alpn', _('ALPN'),
			_('Leave empty unless the server requires specific protocols.'));
		['h2','http/1.1','h3'].forEach(function(v) { oAlpn.value(v, v); });
		oAlpn.modalonly = true;

		var oFp = s.taboption('tls', form.ListValue, 'tls_fingerprint', _('uTLS fingerprint'));
		oFp.value('', _('Default'));
		['chrome','firefox','safari','ios','android','edge','360','qq','random','randomized'].forEach(function(v) {
			oFp.value(v, v);
		});
		oFp.modalonly = true;
		oFp.optional = true;

		var TLS_VERSIONS = ['1.0','1.1','1.2','1.3'];
		var oMinVer = s.taboption('tls', form.ListValue, 'tls_min_version', _('Minimum TLS version'));
		oMinVer.value('', _('Default'));
		TLS_VERSIONS.forEach(function(v) { oMinVer.value(v, v); });
		oMinVer.modalonly = true;
		oMinVer.optional = true;

		var oMaxVer = s.taboption('tls', form.ListValue, 'tls_max_version', _('Maximum TLS version'));
		oMaxVer.value('', _('Default'));
		TLS_VERSIONS.forEach(function(v) { oMaxVer.value(v, v); });
		oMaxVer.modalonly = true;
		oMaxVer.optional = true;
		oMaxVer.validate = function(section_id, value) {
			var min = this.section.formvalue(section_id, 'tls_min_version');
			return (!value || !min || TLS_VERSIONS.indexOf(min) <= TLS_VERSIONS.indexOf(value))
				? true : _('Lower than the minimum version');
		};

		var oEch = s.taboption('tls', form.Flag, 'tls_ech', _('ECH'),
			_('Encrypted Client Hello. Without a config below, sing-box looks it up in the DNS HTTPS record of the SNI.'));
		oEch.modalonly = true;

		var oReality = s.taboption('tls', form.Flag, 'tls_reality', _('REALITY'),
			_('Uses the chrome fingerprint when uTLS fingerprint is Default.'));
		oReality.modalonly = true;

		// TLS detail fields: always shown for forced-TLS protocols, opt-in
		// (tls_enabled) for vless / vmess.
		//
		// uTLS and REALITY are the exceptions: hysteria2 and tuic run over
		// QUIC, whose handshake path in sing-box rejects both outright
		// ("unsupported usage for uTLS" / "… for reality" on every dial), so
		// they are not offered for them — build-config drops them for those
		// types regardless.
		[oSni, oInsec, oAlpn, oMinVer, oMaxVer, oEch, oFp, oReality].forEach(function(opt) {
			var forcedTls = (opt === oFp || opt === oReality || opt === oMinVer || opt === oMaxVer)
				? ['trojan','anytls']
				: ['trojan','hysteria2','tuic','anytls'];
			depAny(opt, 'type', forcedTls);
			opt.depends({ type: 'vless', tls_enabled: '1' });
			opt.depends({ type: 'vmess', tls_enabled: '1' });
		});

		// The ECH config: shown wherever the ECH flag is, while it is on.
		o = s.taboption('tls', form.TextValue, 'tls_ech_config', _('ECH config'),
			_('PEM, including the BEGIN / END lines. Optional.'));
		o.modalonly = true;
		o.rows = 4;
		o.monospace = true;
		depAny(o, 'type', ['trojan','hysteria2','tuic','anytls'], { tls_ech: '1' });
		o.depends({ type: 'vless', tls_enabled: '1', tls_ech: '1' });
		o.depends({ type: 'vmess', tls_enabled: '1', tls_ech: '1' });

		// REALITY's key fields: shown under the same conditions as the flag,
		// and only while it is on.
		function dependsOnReality(opt) {
			depAny(opt, 'type', ['trojan','anytls'], { tls_reality: '1' });
			opt.depends({ type: 'vless', tls_enabled: '1', tls_reality: '1' });
			opt.depends({ type: 'vmess', tls_enabled: '1', tls_reality: '1' });
		}

		o = s.taboption('tls', form.Value, 'tls_reality_public_key', _('REALITY public key'));
		o.modalonly = true;
		o.rmempty = false;
		// An X25519 public key: 32 bytes, unpadded base64url.
		o.validate = function(section_id, value) {
			return /^[A-Za-z0-9_-]{43}$/.test(value)
				? true : _('Expecting a 43-character base64url key');
		};
		dependsOnReality(o);

		o = s.taboption('tls', form.Value, 'tls_reality_short_id', _('REALITY short ID'));
		o.modalonly = true;
		o.validate = function(section_id, value) {
			return /^([0-9A-Fa-f]{2}){0,8}$/.test(value)
				? true : _('Expecting an even number of hex digits, at most 16');
		};
		dependsOnReality(o);

	},

	// The subscription's state, as a badge plus one line of detail:
	//   failed     — the last sync failed (with its reason)
	//   stale      — no successful sync for twice its auto-update interval,
	//                or a week when auto-update is off (same rule as Status)
	//   up to date — otherwise, with the auto-update interval
	_subState: function(section_id) {
		var get = function(o) { return uci.get('treadle', section_id, o); };
		var hours = parseInt(get('auto_update'), 10) || 0;
		var every = hours > 0 ? _('every %d h').format(hours) : _('manual only');
		var badge = function(cls, style, text) {
			return E('span', {
				'class': cls,
				'style': 'padding:1px 7px; border-radius:3px; text-transform:none;' + (style || '')
			}, [ text ]);
		};
		var why = get('sync_error');
		if (get('status') === 'error' || why)
			return E('span', {}, [
				badge('label', DANGER_STYLE, _('failed')), ' ',
				E('span', { 'style': 'opacity:0.75;' }, [ why || _('last sync failed') ])
			]);
		var age = (this._subAge[section_id] || {}).ok_age_s;
		var limit = hours > 0 ? 2 * hours * 3600 : 7 * 86400;
		if (age == null || age > limit)
			return E('span', {}, [
				badge('label warning', '', age == null ? _('never synced') : _('stale')), ' ',
				E('span', { 'style': 'opacity:0.75;' }, [ every ])
			]);
		return E('span', {}, [
			badge('label success', '', _('up to date')), ' ',
			E('span', { 'style': 'opacity:0.75;' }, [ every ])
		]);
	},

	// Every node a group can take as a member, for the Members picker.
	_memberList: function(outbounds) {
		// Subscription name/order lookups shared with routing.js / status.js
		// via lib/subs.js — see that module for the uid-keying rationale.
		var subName = subs.nameMap(), subOrder = subs.orderMap();
		function labelFor(tag, sub_id) {
			return subs.labelFor(tag, sub_id, subName);
		}
		function groupKey(sub_id) {
			return subs.groupKey(sub_id, subOrder);
		}

		// URLTest member candidates: manual nodes from the staged UCI view
		// (a staged rename or fresh add must show its current tag here —
		// list_outbounds only sees committed state; see routing.js
		// addServers), subscription nodes from the RPC, plus any tag
		// already stored on an existing urltest node, so a saved member
		// whose node was removed still shows rather than being silently
		// dropped. First-seen wins, manual first — matching build-config's
		// dedupe policy.
		var memberByTag = {};
		subs.manualNodes().forEach(function(n, i) {
			if (!(n.tag in memberByTag))
				memberByTag[n.tag] = { tag: n.tag, label: n.tag, group: 0, idx: i };
		});
		outbounds.forEach(function(ob, i) {
			if (ob && ob.tag && ob.subscription && !(ob.tag in memberByTag)) {
				memberByTag[ob.tag] = {
					tag:   ob.tag,
					label: labelFor(ob.tag, ob.subscription),
					group: groupKey(ob.subscription),
					idx:   i
				};
			}
		});
		uci.sections('treadle', 'node').forEach(function(n) {
			var obs = n.urltest_outbounds;
			if (!Array.isArray(obs))
				obs = obs ? String(obs).split(/[,\s]+/) : [];
			obs.forEach(function(t) {
				if (t && !(t in memberByTag)) {
					memberByTag[t] = { tag: t, label: t, group: Infinity, idx: 0 };
				}
			});
		});
		var memberList = [];
		for (var k in memberByTag) memberList.push(memberByTag[k]);
		memberList.sort(subs.entryCompare);

		return memberList;
	},

	// The Name field, shared by the group and manual-node tables. Routing
	// references store a node's TAG, so a rename is propagated (see below).
	_tagOption: function(s, tab) {
		var self = this;
		var oTag = (tab ? s.taboption(tab, form.Value, 'tag', _('Name')) : s.option(form.Value, 'tag', _('Name')));
		oTag.rmempty = false;
		oTag.placeholder = _('e.g. MY-VPS-HK');
		// Routing references store the node's TAG, not its section id —
		// subscription nodes have no UCI section, so the tag is the only
		// universal outbound identifier (and what sing-box itself keys on).
		// A rename would therefore dangle every reference to the old tag,
		// and build-config's validation pass would silently fall the
		// affected rules back to direct. Propagate the rename instead:
		// rewrite rule.outbound, routing.final_outbound and urltest member
		// lists inside the same staged save, so
		// Save & Apply commits the rename and the rewires atomically and
		// Reset reverts both together. Skipped when the old tag is not
		// unique among outbounds: with a duplicate tag the references
		// still resolve after the rename (first-seen-wins dedupe), so
		// rewriting them would steal the duplicate's references.
		var tagWrite = oTag.write;
		oTag.write = function(section_id, formvalue) {
			var oldTag = uci.get('treadle', section_id, 'tag');
			if (oldTag && formvalue && oldTag !== formvalue
			    && self._tagIsUnique(oldTag, section_id))
				self._propagateTagRename(oldTag, formvalue);
			return tagWrite.apply(this, arguments);
		};

		return oTag;
	},

	_renderGroups: function(m, memberList) {
		var self = this;
		var s = m.section(form.GridSection, 'node', _('Groups'),
			_('Pick the fastest node among their members. Rules and the default node can point at a group.'));
		s.addremove = true;
		s.sortable  = true;
		s.anonymous = true;
		s.addbtntitle = _('Add group');
		s.modaltitle = function() { return _('Group'); };
		// Groups and manual nodes are both `node` sections; each table shows
		// its own kind.
		s.filter = function(section_id) {
			return uci.get('treadle', section_id, 'type') === 'urltest';
		};
		uid.installGridAdd(s);
		// A section added from this table is a group: set its type before the
		// modal reads its values (handleAdd stages it synchronously, as in
		// _openImported).
		var add = s.handleAdd;
		s.handleAdd = function(ev, name) {
			var sid = name || uid.generate();
			var r = add.call(this, ev, sid);
			uci.set('treadle', sid, 'type', 'urltest');
			return r;
		};
		formpanel.deleteInModal(s);

		var o = this._tagOption(s);
		o.placeholder = _('e.g. Auto');

		var oFrom = s.option(form.DummyValue, '_from', _('Members from'));
		oFrom.modalonly = false;
		oFrom.cfgvalue = function(section_id) {
			var get = function(k) { return uci.get('treadle', section_id, k); };
			if ((get('urltest_mode') || 'manual') !== 'regex')
				return _('Fixed list');
			var srcs = get('urltest_regex_sources') || [];
			if (!Array.isArray(srcs)) srcs = [ srcs ];
			var names = srcs.map(function(u) {
				return u === '_manual' ? _('manual nodes')
					: (uci.get('treadle', u, 'name') || u);
			});
			return _('Pattern %s · %s').format(get('urltest_regex') || '—',
				names.length ? names.join(', ') : _('all subscriptions'));
		};

		var oCount = s.option(form.DummyValue, '_members', _('Members'));
		oCount.modalonly = false;
		oCount.cfgvalue = function(section_id) {
			var live = self._liveGroup[uci.get('treadle', section_id, 'tag')];
			if (live && Array.isArray(live.members))
				return _('%d nodes').format(live.members.length);
			var list = uci.get('treadle', section_id, 'urltest_outbounds');
			if ((uci.get('treadle', section_id, 'urltest_mode') || 'manual') !== 'regex' && list)
				return _('%d nodes').format(Array.isArray(list) ? list.length : 1);
			return '—';
		};

		var oUsing = s.option(form.DummyValue, '_using', _('Using now'));
		oUsing.modalonly = false;
		// editable: grid cells render the element instead of escaping it.
		oUsing.editable = true;
		oUsing.cfgvalue = function(section_id) {
			var live = self._liveGroup[uci.get('treadle', section_id, 'tag')];
			if (!live || !live.now)
				return E('span', { 'style': 'opacity:0.45;', 'title': _('Shown while the group runs and live stats are on') }, [ '—' ]);
			return E('span', { 'style': 'white-space:nowrap;' }, [
				live.now, ' ',
				formatLatency(live.delay_ms ? { delay_ms: live.delay_ms } : { error: _('timeout') })
			]);
		};

		// ── URLTest group ───────────────────────────────────────────────
		// Auto-rotation by latency. Members can be picked explicitly (manual
		// mode) or matched against a tag pattern (regex mode).
		o = s.option(form.ListValue, 'urltest_mode', _('Selection mode'));
		o.value('manual', _('Manual (select nodes)'));
		o.value('regex',  _('Regex (match by tag)'));
		o.modalonly = true;

		o = s.option(form.MultiValue, 'urltest_outbounds', _('Members'));
		// 'select' renders a ui.Dropdown multi-select: checkboxes plus a
		// built-in filter field inside the opened dropdown panel.
		o.widget = 'select';
		memberList.forEach(function(m) { o.value(m.tag, m.label); });
		// With no nodes yet (fresh install), transformChoices() returns null,
		// which slips past ui.Dropdown's `typeof` null check and crashes the
		// Add modal on Object.keys(null). Coerce to {}.
		o.transformChoices = function() {
			return form.MultiValue.prototype.transformChoices.apply(this) || {};
		};
		o.modalonly = true;
		o.depends('urltest_mode', 'manual');

		o = s.option(form.Value, 'urltest_regex', _('Tag pattern'),
			_('POSIX extended regular expression (ERE) matched against each ' +
			  'node tag. Use <code>|</code> for alternation, <code>[0-9]</code> ' +
			  'for digits, <code>.</code> for any character, <code>^</code>/' +
			  '<code>$</code> to anchor. Note this is POSIX, not PCRE — ' +
			  '<code>\\d</code> / <code>\\w</code> are not supported; ' +
			  'write <code>[0-9]</code> / <code>[A-Za-z0-9_]</code> instead.'));
		o.modalonly = true;
		o.placeholder = _('e.g. ^HK-|^SG-');
		o.depends('urltest_mode', 'regex');

		// Restrict regex matching to nodes from selected sources. Empty =
		// match across every source (the behaviour before this field existed).
		// Sentinel `_manual` covers UCI-defined manual nodes; remaining values
		// are subscription uids (the subscription section's name). `_manual`
		// is non-hex and cannot collide with a uid.
		o = s.option(form.MultiValue, 'urltest_regex_sources', _('Sources'),
			_('Subscriptions whose nodes are evaluated against the pattern. ' +
			  'Leave empty to match nodes from every source (current and future). ' +
			  'Restrict to specific subscriptions if you want a new feed to require ' +
			  'an explicit opt-in before its tags can join this group — useful when ' +
			  'the pattern is broad (e.g. country names) and a future provider ' +
			  'might ship matching tags. The Treadle log records which sources ' +
			  'contributed members on each build.'));
		o.widget = 'select';
		o.value('_manual', _('Manual nodes'));
		uci.sections('treadle', 'subscription').forEach(function(sub) {
			var u = sub['.name'];
			o.value(u, sub.name || u);
		});
		o.modalonly = true;
		o.optional = true;
		o.depends('urltest_mode', 'regex');

		// Test URL: combobox (form.Value auto-promotes to ui.Combobox when
		// .value() entries are present) — preset picks for the two most
		// common /generate_204 endpoints, plus free-text entry for any
		// custom URL the user prefers to type.
		o = s.option(form.Value, 'urltest_url', _('Test URL'));
		o.modalonly = true;
		o.default = 'https://www.gstatic.com/generate_204';
		// Required (default is set) — drops the "unspecified" empty entry
		// that form.Value would otherwise insert in the Combobox dropdown.
		o.rmempty = false;
		o.value('https://www.gstatic.com/generate_204',     'Google (HTTPS)');
		o.value('http://www.gstatic.com/generate_204',      'Google (HTTP)');
		o.value('https://cp.cloudflare.com/generate_204',   'Cloudflare (HTTPS)');
		o.value('http://cp.cloudflare.com/generate_204',    'Cloudflare (HTTP)');

		o = s.option(form.Value, 'urltest_interval', _('Interval'));
		o.modalonly = true;
		o.placeholder = '3m';

		o = s.option(form.Value, 'urltest_tolerance', _('Tolerance (ms)'));
		o.modalonly = true;
		o.datatype = 'uinteger';
		o.placeholder = '50';

		o = s.option(form.ListValue, 'urltest_member_order', _('Member order'),
			_('sing-box prefers the first members of a group whenever their latencies ' +
			  'are within the tolerance, so in list order a group keeps using its first ' +
			  'few nodes. Random spreads that across the group; latency puts the fastest ' +
			  'measured nodes first, in random order among near-equals. The order changes ' +
			  'only when sing-box restarts for another reason, never on its own.'));
		o.modalonly = true;
		o.value('list',    _('List order'));
		o.value('shuffle', _('Random'));
		o.value('latency', _('Latency, then random'));
		o.default = 'list';

		o = s.option(form.Value, 'urltest_max_members', _('Maximum members'),
			_('Keep only this many members, in the order above, preferring nodes on ' +
			  'different servers. Each member costs one test per interval. Empty keeps all.'));
		o.modalonly = true;
		o.datatype = 'range(1,1000)';
		o.placeholder = _('all');

		o = s.option(form.Flag, 'urltest_interrupt_exist_connections',
			_('Interrupt existing connections'),
			_('Drop connections routed through this group when its active member ' +
			  'changes, so apps reconnect through the new node. Useful for HTTP/web; ' +
			  'noisy for SSH and other long-lived sessions.'));
		o.modalonly = true;
		o.rmempty = true;
	},

	_showNodes: function(section_id) {
		var self = this;
		var name = uci.get('treadle', section_id, 'name') || section_id;
		var clashOn = (uci.get('treadle', 'global', 'clash_api_enabled') === '1');
		ui.showModal(_('Nodes — %s').format(name), [
			E('p', { 'class': 'spinning' }, [ _('Loading…') ]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, [ _('Close') ])
			])
		]);
		return callListSubscriptionNodes(section_id).then(function(res) {
			// luci.jsonc serialises an empty Lua array as `{}`, so a
			// subscription with no nodes arrives as an object, not [].
			// Coerce so `.length`/`.forEach` below behave and the empty
			// case shows the "No nodes" hint rather than a blank table.
			var nodes = (res && Array.isArray(res.nodes)) ? res.nodes : [];
			var content;
			if (nodes.length === 0) {
				content = E('p', {}, [
					_('No nodes. Sync this subscription to populate the list.')
				]);
			} else {
				var headerCells = [
					E('th', { 'class': 'th cbi-section-table-cell' }, [ _('Name') ]),
					E('th', { 'class': 'th cbi-section-table-cell' }, [ _('Type') ]),
					E('th', { 'class': 'th cbi-section-table-cell' }, [ _('Server') ])
				];
				if (clashOn) {
					headerCells.push(E('th', { 'class': 'th cbi-section-table-cell' }, [ _('Latency') ]));
					headerCells.push(E('th', { 'class': 'th cbi-section-table-cell cbi-section-actions' }, []));
				}
				var rows = [ E('tr', { 'class': 'tr cbi-section-table-titles' }, headerCells) ];
				for (var i = 0; i < nodes.length; i++) {
					var n = nodes[i];
					var srv = n.server || '';
					if (srv !== '' && n.server_port)
						srv += ':' + n.server_port;
					var cells = [
						E('td', { 'class': 'td' }, [ n.tag || '' ]),
						E('td', { 'class': 'td' }, [ n.type || '' ]),
						E('td', { 'class': 'td' }, [ srv ])
					];
					if (clashOn) {
						var tag = n.tag || '';
						// Detailed variant: the modal has room to show the
						// tested-time inline, where the grid's tooltip-only
						// rendering is mouse-only.
						var span = E('span', {}, [ formatLatency(self._latency[tag], true) ]);
						self._registerLatencyCell(tag, span, true);
						cells.push(E('td', { 'class': 'td' }, [ span ]));
						cells.push(E('td', { 'class': 'td cbi-section-actions' }, [
							E('button', {
								'class': 'btn cbi-button cbi-button-neutral',
								'click': (function(t) {
									return function(ev) { self._testOne(ev.currentTarget, t); };
								})(tag)
							}, [ _('Test') ])
						]));
					}
					var row = E('tr', { 'class': 'tr cbi-section-table-row' }, cells);
					// Searchable text for the filter box below — tag, type
					// and server cover everything a user would hunt by.
					row._treadleFilter = ((n.tag || '') + ' ' + (n.type || '')
						+ ' ' + srv).toLowerCase();
					rows.push(row);
				}
				var table = E('table', { 'class': 'table cbi-section-table' }, rows);
				var pieces = [
					E('div', { 'style': 'max-height:70vh; overflow:auto;' }, [ table ])
				];
				// Subscriptions commonly carry 100+ nodes — a substring
				// filter beats scroll-hunting. Hidden for short lists,
				// where it would only be clutter.
				if (nodes.length >= 10) {
					var countEl = E('span', {
						'style': 'opacity:0.6; font-size:0.9em; white-space:nowrap;'
					}, [ '%d / %d'.format(nodes.length, nodes.length) ]);
					var filterEl = E('input', {
						'type': 'text',
						'class': 'cbi-input-text',
						'style': 'flex:1 1 auto;',
						'placeholder': _('Type to filter by name, type or server…'),
						'input': function(ev) {
							var q = ev.currentTarget.value.trim().toLowerCase();
							var shown = 0;
							table.querySelectorAll('tr').forEach(function(tr) {
								if (tr._treadleFilter == null) return;  // header row
								var hit = (q === '' || tr._treadleFilter.indexOf(q) !== -1);
								tr.style.display = hit ? '' : 'none';
								if (hit) shown++;
							});
							countEl.textContent = '%d / %d'.format(shown, nodes.length);
						}
					});
					pieces.unshift(E('div', {
						'style': 'display:flex; align-items:center; gap:0.6em; margin-bottom:0.5em;'
					}, [ filterEl, countEl ]));
				}
				content = E('div', {}, pieces);
			}
			var footer = [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, [ _('Close') ])
			];
			if (clashOn && nodes.length > 0) {
				footer.unshift(' ');
				footer.unshift(E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': function() {
						var tags = [];
						nodes.forEach(function(n) {
							if (n.tag && n.type !== 'urltest')
								tags.push(n.tag);
						});
						// Same code path as the global Test all — the
						// background runner accepts an optional tag list
						// to scope the run. Avoids the per-tag RPC pool
						// (which was 18× slower than the runner due to
						// rpcd dispatch overhead on every call).
						self._doTestAll(tags);
					}
				}, [ _('Test all in this subscription') ]));
			}
			ui.showModal(_('Nodes — %s (%d)').format(name, nodes.length), [
				content,
				E('div', { 'class': 'right' }, footer)
			]);
			// LuCI's stock .modal class clamps the modal at a narrow
			// max-width — fine for a confirm dialog, too tight for a
			// 5-column node list. Widen the modal container itself
			// (overriding only max-width keeps LuCI's own centering
			// and inner padding intact); the inner table then expands
			// to fill, instead of overflowing into the page underneath.
			var modal = document.querySelector('#modal_overlay > .modal') ||
			            document.querySelector('.modal');
			if (modal) modal.style.maxWidth = 'min(80vw, 850px)';
		}).catch(function() {
			ui.showModal(_('Nodes — %s').format(name), [
				E('p', {}, [ _('Failed to load nodes.') ]),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': ui.hideModal
					}, [ _('Close') ])
				])
			]);
		});
	},

	// Register a freshly-rendered latency cell so _refreshLatencyCell can
	// find it later by tag. We use a plain object map instead of a CSS
	// attribute selector because tags include emoji (🇭🇰, 🇯🇵, …) whose
	// surrogate-pair escaping in CSS selectors isn't portable — browsers
	// vary in whether they accept '\d83c\dded' as a single character. A
	// JS string key sidesteps the issue entirely.
	// `detailed` is remembered on the element so a refresh re-renders the
	// cell with the same variant it was created with (the modal's cells
	// carry the inline tested-time, the grid's do not).
	_registerLatencyCell: function(tag, element, detailed) {
		if (!tag) return;
		element._treadleDetailed = !!detailed;
		var arr = this._latencyCells[tag];
		if (!arr) { arr = []; this._latencyCells[tag] = arr; }
		arr.push(element);
	},

	// Update every live cell registered for this tag. Drops references to
	// elements no longer in the DOM (e.g. closed subscription modals) so
	// the map can't grow unbounded across a long-running session.
	_refreshLatencyCell: function(tag) {
		var arr = this._latencyCells[tag];
		if (!arr || arr.length === 0) return;
		var result = this._latency[tag];
		var live = [];
		for (var i = 0; i < arr.length; i++) {
			var el = arr[i];
			if (!el || !el.isConnected) continue;
			while (el.firstChild) el.removeChild(el.firstChild);
			el.appendChild(formatLatency(result, el._treadleDetailed));
			live.push(el);
		}
		this._latencyCells[tag] = live;
	},

	// Adopt a runner that is already in flight (forked by the backend
	// after a subscription's first sync, or started before a tab reload):
	// when the status file says running, drive the standard poll loop so
	// cells refresh as its results land.
	_resumeTestPoll: function() {
		var self = this;
		return callTestAllStatus().then(function(status) {
			if (!status || !status.running || self._testAllRunning)
				return;
			self._testAllRunning = true;
			return self._pollTestAll();
		}).catch(function() { /* no runner state — nothing to adopt */ });
	},

	// Single-node probe: a one-tag run of the background runner (which
	// spins up the ephemeral probe instance, probes, tears it down). `btn`
	// is the row's Test button; spin it in place (preserves width/height
	// so the row doesn't jump) until the run settles. Refuses while a
	// "Test all" batch is in flight — the runner's lock would reject the
	// second run anyway, and the UI guard gives a friendlier message.
	// Completion is driven by the same _pollTestAll loop the batch path
	// uses: it refreshes the cell from the cache as the result
	// lands, its timer is tracked in _testAllTimer (so _teardown cancels
	// it on tab switch), and it clears _testAllRunning when done.
	_testOne: function(btn, tag) {
		var self = this;
		if (this._testAllRunning) {
			notify.notice(_('A latency test run is already in progress.'));
			return Promise.resolve();
		}
		this._testAllRunning = true;
		this._testAllAborted = false;
		var label = btn.textContent;
		var w = btn.offsetWidth, h = btn.offsetHeight;
		btn.classList.add('spinning');
		btn.style.width  = w + 'px';
		btn.style.height = h + 'px';
		btn.textContent  = '';
		return callTestAllStart([ tag ]).then(function(res) {
			if (res && res.error)
				throw new Error(res.error);
			return self._pollTestAll();
		}).catch(function(err) {
			self._testAllRunning = false;
			var detail = err && (err.message || String(err)) || _('unknown error');
			notify.error(_('Test failed: ') + detail);
		}).finally(function() {
			btn.style.width  = '';
			btn.style.height = '';
			btn.classList.remove('spinning');
			btn.textContent  = label;
		});
	},

	// Gather every concrete-endpoint tag known to Treadle: manual nodes from
	// UCI (skipping group types) plus subscription nodes from the cached
	// outbound list. Dedup by tag — first-seen wins, matching build-config's
	// manual-overrides-subscription policy.
	_collectAllTags: function() {
		var tags = [], seen = {};
		uci.sections('treadle', 'node').forEach(function(n) {
			var t = n.tag, ty = n.type;
			if (t && ty !== 'urltest' && !seen[t]) {
				seen[t] = true;
				tags.push(t);
			}
		});
		(this._outbounds || []).forEach(function(ob) {
			if (ob.tag && ob.subscription
			    && ob.type !== 'urltest'
			    && !seen[ob.tag]) {
				seen[ob.tag] = true;
				tags.push(ob.tag);
			}
		});
		return tags;
	},

	// Section "Test all" handler — dispatches directly. Probing is
	// non-destructive and the spinning button already shows a run is in
	// progress, so a confirm step only added friction (the per-subscription
	// batch button never had one either).
	_testAll: function() {
		var tags = this._collectAllTags();
		if (tags.length === 0) {
			notify.notice(_('No nodes to test.'));
			return;
		}
		return this._doTestAll(tags);
	},

	// "Test all": fork the background runner on the device and poll for
	// completion. The runner starts the ephemeral probe instance, probes
	// each tag via /proxies/<tag>/delay in parallel shell-forked batches
	// and writes results into /var/etc/treadle/latency.json; we refresh
	// cells from that cache between polls so results land progressively.
	// No long-running RPC, so LuCI's XHR timeout is a non-issue.
	//
	// `tags` is optional: pass a list to scope the run to a subset (the
	// per-subscription "Test all in this subscription" button does this);
	// omit/empty to probe every node Treadle knows about.
	_doTestAll: function(tags) {
		if (this._testAllRunning) {
			notify.notice(_('A latency test run is already in progress.'));
			return Promise.resolve();
		}
		this._testAllRunning = true;
		this._testAllAborted = false;

		var self = this;
		ui.hideModal();

		return callTestAllStart(Array.isArray(tags) ? tags : []).then(function(res) {
			if (res && res.error) {
				throw new Error(res.error);
			}
			return self._pollTestAll();
		}).catch(function(err) {
			self._testAllRunning = false;
			var detail = err && (err.message || String(err)) || _('unknown error');
			notify.error(_('Test all failed: ') + detail);
		});
	},

	// Spin and disable the section's Test all button while any run is in
	// flight — the progress indicator for every run, whichever button (or
	// the backend) started it. Same look as ui.createHandlerFn's busy state,
	// which also drives it when the run came from that button.
	_setTestBusy: function(on) {
		var btn = this._testAllBtn;
		if (!btn)
			return;
		btn.classList.toggle('spinning', on);
		btn.disabled = on;
	},

	// Drive the poll loop while the background runner does its work.
	// Each tick: ask for status and refresh cells from the cache. Stops
	// when status.running flips off, when the safety timeout trips, or
	// when the panel is torn down.
	_pollTestAll: function() {
		var self = this;
		var startMs = Date.now();
		var POLL_INTERVAL = 1500;
		// Safety cap: if the runner crashes without clearing the status
		// (e.g. SIGKILL), we still want the UI to stop polling. 3 min is
		// generous — the runner's own clash timeout is 60 s.
		var MAX_ELAPSED_MS = 3 * 60 * 1000;

		return new Promise(function(resolve, reject) {
			function refreshCells() {
				return callGetLastLatency().then(function(c) {
					var results = (c && c.results) || {};
					for (var tag in results) {
						self._latency[tag] = results[tag];
						self._refreshLatencyCell(tag);
					}
				}).catch(function() { /* transient — try again next tick */ });
			}

			function tick() {
				if (self._testAllAborted) {
					resolve({ aborted: true });
					return;
				}
				if (Date.now() - startMs > MAX_ELAPSED_MS) {
					reject(new Error(_('runner timed out (status file never cleared)')));
					return;
				}

				callTestAllStatus().then(function(status) {
					return refreshCells().then(function() { return status; });
				}).then(function(status) {
					if (status && !status.running) {
						resolve(status);
					} else {
						self._testAllTimer = setTimeout(tick, POLL_INTERVAL);
					}
				}).catch(function() {
					self._testAllTimer = setTimeout(tick, POLL_INTERVAL);
				});
			}
			self._setTestBusy(true);
			self._testAllTimer = setTimeout(tick, POLL_INTERVAL);
		}).finally(function() {
			self._setTestBusy(false);
		}).then(function(status) {
			// Left the tab mid-run: _teardown already reset the state (a new
			// mount may own it by now), and there is no result to report.
			if (status && status.aborted)
				return;
			self._testAllRunning = false;
			if (status && status.error) {
				notify.error(_('Test all failed: %s').format(status.error));
				return;
			}
			var tested = (status && status.tested) || 0;
			var errors = (status && status.errors) || 0;
			notify.notice(errors > 0
				? _('Tested %d nodes — %d timed out.').format(tested + errors, errors)
				: _('Tested %d nodes.').format(tested));
		});
	},

	// True when `tag` belongs to the given node section alone — no other
	// manual node section and no subscription node carries it. Subscription
	// tags come from the outbound list cached at load time, which is fine:
	// a sync mid-edit re-renders the whole panel anyway.
	_tagIsUnique: function(tag, section_id) {
		var dup = false;
		uci.sections('treadle', 'node').forEach(function(n) {
			if (n['.name'] !== section_id && n.tag === tag) dup = true;
		});
		(this._outbounds || []).forEach(function(ob) {
			if (ob.subscription && ob.tag === tag) dup = true;
		});
		return !dup;
	},

	// Rewrite every staged-or-saved routing reference from oldTag to
	// newTag. Plain uci.set calls, so the rewrites ride the same staged
	// change set as the rename itself.
	_propagateTagRename: function(oldTag, newTag) {
		var changed = 0;

		uci.sections('treadle', 'rule').forEach(function(r) {
			if (r.outbound === oldTag) {
				uci.set('treadle', r['.name'], 'outbound', newTag);
				changed++;
			}
		});

		if (uci.get('treadle', 'routing', 'final_outbound') === oldTag) {
			uci.set('treadle', 'routing', 'final_outbound', newTag);
			changed++;
		}

		// List-typed references (urltest members). UCI
		// hands back an array for lists and a string for a single value;
		// tags legitimately contain spaces, so only exact-element matches
		// are rewritten — never substring or split-on-whitespace.
		var renameInList = function(sid, opt) {
			var v = uci.get('treadle', sid, opt);
			if (Array.isArray(v)) {
				if (v.indexOf(oldTag) === -1) return;
				uci.set('treadle', sid, opt, v.map(function(t) {
					return (t === oldTag) ? newTag : t;
				}));
				changed++;
			} else if (v === oldTag) {
				uci.set('treadle', sid, opt, newTag);
				changed++;
			}
		};
		uci.sections('treadle', 'node').forEach(function(n) {
			if (n.type === 'urltest')
				renameInList(n['.name'], 'urltest_outbounds');
		});

		if (changed > 0)
			notify.notice(_('Renamed "%s" to "%s" — %d routing reference(s) updated to follow.')
				.format(oldTag, newTag, changed));
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	handleReset:     function() { return formpanel.resetGrid(this); },

	// Called by the host (main.js _activate) when the panel is being
	// replaced. Stop the Test-all poll loop so it doesn't keep firing
	// against a detached panel, and clear the running flag so a fresh
	// mount can start a new Test-all instead of being silently inert
	// until the 3-min MAX_ELAPSED_MS cap trips.
	_teardown: function() {
		this._testAllAborted = true;
		if (this._testAllTimer) {
			clearTimeout(this._testAllTimer);
			this._testAllTimer = null;
		}
		this._testAllRunning = false;
	}
});
