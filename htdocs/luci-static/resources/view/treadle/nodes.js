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
'require view.treadle.lib.ordersave as ordersave';
'require view.treadle.lib.formpanel as formpanel';
'require view.treadle.lib.subs as subs';
'require view.treadle.lib.badges as badges';
'require view.treadle.lib.subsync as subsync';
'require view.treadle.uid as uid';

var callSyncAll = rpc.declare({
	object: 'luci.treadle',
	method: 'sync_all_subscriptions',
	expect: { '': {} }
});

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

var callTestAllStatus = rpc.declare({
	object: 'luci.treadle',
	method: 'test_all_status',
	expect: { '': {} }
});


// Color-coded latency badge shared with the Status panel — lives in
// lib/badges.js so the two columns agree on what 'yellow' means.
var formatLatency = badges.formatLatency;


// Types with a server endpoint. `direct` is excluded — a direct outbound has
// no server field (build-config drops it); it is just an optional override.
var SERVER_TYPES    = ['vless','vmess','trojan','shadowsocks','hysteria2','tuic','anytls','wireguard','socks'];
var TRANSPORT_TYPES = ['vless','vmess','trojan','anytls'];

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
			callGetLastLatency().catch(function() { return { results: {} }; })
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

		this._renderSubscriptions(m);
		this._renderNodes(m, data);

		this.map = m;
		ordersave.install(m, 'subscription');
		ordersave.install(m, 'node');

		return m.render().then(function(node) {
			// Both batch actions ("Sync all now" + "Test all") sit next to
			// the Subscriptions section's Add button so they're visible
			// without scrolling past a long node list. The first
			// .cbi-section-create in document order is the subscriptions
			// one since that section renders first.
			var clashOn = (uci.get('treadle', 'global', 'clash_api_enabled') === '1');
			var subsCreate = node.querySelector('.cbi-section-create');
			if (subsCreate) {
				subsCreate.appendChild(E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'style': 'margin-left:0.4em',
					'click': ui.createHandlerFn(self, '_syncAll')
				}, [ _('Sync all now') ]));
				if (clashOn)
					subsCreate.appendChild(E('button', {
						'class': 'btn cbi-button cbi-button-neutral',
						'style': 'margin-left:0.4em',
						'click': ui.createHandlerFn(self, '_testAll')
					}, [ _('Test all') ]));
			}
			// Breathing room between the two GridSections — matches the
			// gap between sibling sections on the stock DHCP page.
			var nodeSection = node.querySelector('#cbi-treadle-node');
			if (nodeSection)
				nodeSection.style.marginTop = '2em';
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
			_('Node subscriptions.'));
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

		var oEnabled = s.option(form.Flag, 'enabled', _('Enabled'));
		oEnabled['default'] = '1';
		oEnabled.rmempty = false;
		oEnabled.editable = true;

		var oName = s.option(form.Value, 'name', _('Name'));
		oName.rmempty = false;
		oName.placeholder = _('My Subscription');

		// RPC-populated read-only fields shown in the grid row only —
		// modalonly=false excludes them from the per-row edit modal.
		var oCount = s.option(form.DummyValue, 'node_count', _('Nodes'));
		oCount.modalonly = false;

		var oView = s.option(form.Button, '_view', _('View'));
		oView.modalonly = false;
		oView.editable = true;
		oView.inputtitle = _('View');
		oView.inputstyle = 'neutral';
		oView.onclick = function(ev, section_id) {
			return self._showNodes(section_id);
		};

		var oLast = s.option(form.DummyValue, 'last_sync',  _('Last sync'));
		oLast.modalonly = false;
		var oStatus = s.option(form.DummyValue, 'status',  _('Status'));
		oStatus.modalonly = false;

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

	_renderNodes: function(m, data) {
		var self = this;
		var outbounds = (data && data[1] && Array.isArray(data[1].outbounds))
			? data[1].outbounds : [];
		// Used by _collectAllTags to drive "Test all" — same data the row
		// renderer already consumes, just kept available across handlers.
		this._outbounds = outbounds;

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

		var s = m.section(form.GridSection, 'node', _('Nodes'),
			_('Manually configured proxy nodes.'));
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

		s.tab('general',   _('General'));
		s.tab('transport', _('Transport'));
		s.tab('tls',       _('TLS'));
		s.tab('group',     _('URLTest'));

		var o;

		// ── General: identity + protocol credentials ────────────────────
		// ListValue options below intentionally carry no `default`: the
		// first value() entry is the implicit default, so the field is
		// written once on create but not re-written on an unchanged save
		// (which would register a phantom UCI change).
		var oTag = s.taboption('general', form.Value, 'tag', _('Name'));
		oTag.rmempty = false;
		oTag.placeholder = _('e.g. MY-VPS-HK');
		// Routing references store the node's TAG, not its section id —
		// subscription nodes have no UCI section, so the tag is the only
		// universal outbound identifier (and what sing-box itself keys on).
		// A rename would therefore dangle every reference to the old tag,
		// and build-config's validation pass would silently fall the
		// affected rules back to direct. Propagate the rename instead:
		// rewrite rule.outbound, routing.final_outbound, urltest member
		// lists and Basic's server picks inside the same staged save, so
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

		var oType = s.taboption('general', form.ListValue, 'type', _('Type'));
		[['urltest','URLTest'],
		 ['vless','VLESS'],['vmess','VMess'],['trojan','Trojan'],
		 ['shadowsocks','Shadowsocks'],['hysteria2','Hysteria2'],['tuic','TUIC'],
		 ['anytls','AnyTLS'],['wireguard','WireGuard'],['socks','SOCKS5'],
		 ['direct','Direct']].forEach(function(t) {
			oType.value(t[0], t[1]);
		});

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

		o = s.taboption('transport', form.Value, 'transport_grpc_service', _('gRPC service'));
		o.modalonly = true;
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'grpc' });

		o = s.taboption('transport', form.Value, 'transport_http_path', _('HTTP path'));
		o.modalonly = true;
		o.placeholder = '/';
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'http' });

		o = s.taboption('transport', form.Value, 'transport_http_host', _('HTTP host'));
		o.modalonly = true;
		depAny(o, 'type', TRANSPORT_TYPES, { transport_type: 'http' });

		// ── TLS ─────────────────────────────────────────────────────────
		o = s.taboption('tls', form.Flag, 'tls_enabled', _('TLS'));
		o.modalonly = true;
		depAny(o, 'type', ['vless','vmess']);

		var oSni = s.taboption('tls', form.Value, 'tls_sni', _('SNI'));
		oSni.modalonly = true;
		oSni.placeholder = _('e.g. example.com');

		var oInsec = s.taboption('tls', form.Flag, 'tls_insecure', _('Allow insecure'));
		oInsec.modalonly = true;

		var oFp = s.taboption('tls', form.ListValue, 'tls_fingerprint', _('uTLS fingerprint'));
		oFp.value('', _('Default'));
		['chrome','firefox','safari','ios','edge','random'].forEach(function(v) {
			oFp.value(v, v);
		});
		oFp.modalonly = true;
		oFp.optional = true;

		// TLS detail fields: always shown for forced-TLS protocols, opt-in
		// (tls_enabled) for vless / vmess.
		//
		// uTLS is the exception: hysteria2 and tuic run over QUIC, whose
		// handshake path in sing-box rejects a uTLS config outright
		// ("unsupported usage for uTLS" on every dial), so the fingerprint
		// picker is not offered for them — build-config drops the block for
		// those types regardless.
		[oSni, oInsec, oFp].forEach(function(opt) {
			var forcedTls = (opt === oFp)
				? ['trojan','anytls']
				: ['trojan','hysteria2','tuic','anytls'];
			depAny(opt, 'type', forcedTls);
			opt.depends({ type: 'vless', tls_enabled: '1' });
			opt.depends({ type: 'vmess', tls_enabled: '1' });
		});

		// ── URLTest group ───────────────────────────────────────────────
		// Auto-rotation by latency. Members can be picked explicitly (manual
		// mode) or matched against a tag pattern (regex mode).
		o = s.taboption('group', form.ListValue, 'urltest_mode', _('Selection mode'));
		o.value('manual', _('Manual (select nodes)'));
		o.value('regex',  _('Regex (match by tag)'));
		o.modalonly = true;
		o.depends('type', 'urltest');

		o = s.taboption('group', form.MultiValue, 'urltest_outbounds', _('Members'));
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
		o.depends({ type: 'urltest', urltest_mode: 'manual' });

		o = s.taboption('group', form.Value, 'urltest_regex', _('Tag pattern'),
			_('POSIX extended regular expression (ERE) matched against each ' +
			  'node tag. Use <code>|</code> for alternation, <code>[0-9]</code> ' +
			  'for digits, <code>.</code> for any character, <code>^</code>/' +
			  '<code>$</code> to anchor. Note this is POSIX, not PCRE — ' +
			  '<code>\\d</code> / <code>\\w</code> are not supported; ' +
			  'write <code>[0-9]</code> / <code>[A-Za-z0-9_]</code> instead.'));
		o.modalonly = true;
		o.placeholder = 'ASIA-Singapore-[0-9]{2}|EU-.*';
		o.depends({ type: 'urltest', urltest_mode: 'regex' });

		// Restrict regex matching to nodes from selected sources. Empty =
		// match across every source (the behaviour before this field existed).
		// Sentinel `_manual` covers UCI-defined manual nodes; remaining values
		// are subscription uids (the subscription section's name). `_manual`
		// is non-hex and cannot collide with a uid.
		o = s.taboption('group', form.MultiValue, 'urltest_regex_sources', _('Sources'),
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
		o.depends({ type: 'urltest', urltest_mode: 'regex' });

		// Test URL: combobox (form.Value auto-promotes to ui.Combobox when
		// .value() entries are present) — preset picks for the two most
		// common /generate_204 endpoints, plus free-text entry for any
		// custom URL the user prefers to type.
		o = s.taboption('group', form.Value, 'urltest_url', _('Test URL'));
		o.modalonly = true;
		o.depends('type', 'urltest');
		o.default = 'https://www.gstatic.com/generate_204';
		// Required (default is set) — drops the "unspecified" empty entry
		// that form.Value would otherwise insert in the Combobox dropdown.
		o.rmempty = false;
		o.value('https://www.gstatic.com/generate_204',     'Google (HTTPS)');
		o.value('http://www.gstatic.com/generate_204',      'Google (HTTP)');
		o.value('https://cp.cloudflare.com/generate_204',   'Cloudflare (HTTPS)');
		o.value('http://cp.cloudflare.com/generate_204',    'Cloudflare (HTTP)');

		o = s.taboption('group', form.Value, 'urltest_interval', _('Interval'));
		o.modalonly = true;
		o.placeholder = '3m';
		o.depends('type', 'urltest');

		o = s.taboption('group', form.Value, 'urltest_tolerance', _('Tolerance (ms)'));
		o.modalonly = true;
		o.datatype = 'uinteger';
		o.placeholder = '50';
		o.depends('type', 'urltest');

		o = s.taboption('group', form.Flag, 'urltest_interrupt_exist_connections',
			_('Interrupt existing connections'),
			_('Drop connections routed through this group when its active member ' +
			  'changes, so apps reconnect through the new node. Useful for HTTP/web; ' +
			  'noisy for SSH and other long-lived sessions.'));
		o.modalonly = true;
		o.rmempty = true;
		o.depends('type', 'urltest');
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
	// cells refresh as its results land. The detached span stands in for
	// the banner's elapsed element — _pollTestAll only touches it when it
	// is connected to the DOM.
	_resumeTestPoll: function() {
		var self = this;
		return callTestAllStatus().then(function(status) {
			if (!status || !status.running || self._testAllRunning)
				return;
			self._testAllRunning = true;
			return self._pollTestAll(E('span'), null);
		}).catch(function() { /* no runner state — nothing to adopt */ });
	},

	// Single-node probe: a one-tag run of the background runner (which
	// spins up the ephemeral probe instance, probes, tears it down). `btn`
	// is the row's Test button; spin it in place (preserves width/height
	// so the row doesn't jump) until the run settles. Refuses while a
	// "Test all" batch is in flight — the runner's lock would reject the
	// second run anyway, and the UI guard gives a friendlier message.
	// Completion is driven by the same banner-less _pollTestAll loop the
	// batch path uses: it refreshes the cell from the cache as the result
	// lands, its timer is tracked in _testAllTimer (so _teardown cancels
	// it on tab switch), and it clears _testAllRunning when done.
	_testOne: function(btn, tag) {
		var self = this;
		if (this._testAllRunning) {
			ui.addNotification(null,
				E('p', _('A latency test run is already in progress.')),
				'info');
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
			return self._pollTestAll(E('span'), null);
		}).catch(function(err) {
			self._testAllRunning = false;
			var detail = err && (err.message || String(err)) || _('unknown error');
			ui.addNotification(null,
				E('p', [ _('Test failed: '), detail ]),
				'error');
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
	// non-destructive and the progress banner already reports what's
	// running, so a confirm step only added friction (the per-subscription
	// batch button never had one either).
	_testAll: function() {
		var tags = this._collectAllTags();
		if (tags.length === 0) {
			ui.addNotification(null, E('p', _('No nodes to test.')), 'info');
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
			ui.addNotification(null,
				E('p', _('A latency test run is already in progress.')),
				'warning');
			return Promise.resolve();
		}
		this._testAllRunning = true;
		this._testAllAborted = false;

		var self = this;
		ui.hideModal();

		var elapsedEl = E('span', {}, [ _('Starting…') ]);
		var banner = ui.addNotification(_('Latency tests running'), [
			E('p', {}, [ elapsedEl ]),
			E('p', { 'style': 'opacity:0.7; font-size:0.9em; margin:0;' }, [
				_('Probes run in parallel on the device. ' +
				  'You can switch tabs — results land as they arrive.')
			])
		], 'info');

		return callTestAllStart(Array.isArray(tags) ? tags : []).then(function(res) {
			if (res && res.error) {
				throw new Error(res.error);
			}
			return self._pollTestAll(elapsedEl, banner);
		}).catch(function(err) {
			self._testAllRunning = false;
			if (banner && banner.parentNode)
				banner.parentNode.removeChild(banner);
			var detail = err && (err.message || String(err)) || _('unknown error');
			ui.addNotification(null,
				E('p', [ _('Test all failed: '), detail ]),
				'error');
		});
	},

	// Drive the poll loop while the background runner does its work.
	// Each tick: ask for status, refresh cells from the cache, update
	// the banner's elapsed counter. Stops when status.running flips off,
	// when the safety timeout trips, or when the panel is torn down.
	_pollTestAll: function(elapsedEl, banner) {
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
				var elapsed = Math.floor((Date.now() - startMs) / 1000);
				if (elapsedEl.parentNode)
					elapsedEl.textContent = _('Probing… %ds elapsed').format(elapsed);

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
			self._testAllTimer = setTimeout(tick, POLL_INTERVAL);
		}).then(function(status) {
			self._testAllRunning = false;
			if (banner && banner.parentNode)
				banner.parentNode.removeChild(banner);
			if (status && status.error) {
				ui.addNotification(null,
					E('p', _('Test all failed: %s').format(status.error)),
					'error');
				return;
			}
			var tested = (status && status.tested) || 0;
			var errors = (status && status.errors) || 0;
			ui.addNotification(null, E('p',
				errors > 0
					? _('Tested %d nodes — %d timed out.').format(tested + errors, errors)
					: _('Tested %d nodes.').format(tested)),
				'info');
		});
	},

	_syncAll: function() {
		var self = this;
		ui.showModal(_('Sync all subscriptions'), [
			E('p', {}, [
				_('This downloads every subscription and then reloads this tab ' +
				  'from the saved configuration. Unsaved changes on this tab ' +
				  'will be discarded.')
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': ui.hideModal
				}, [ _('Cancel') ]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, '_doSyncAll')
				}, [ _('Sync all') ])
			])
		]);
	},

	_doSyncAll: function() {
		var self = this;
		ui.hideModal();
		return callSyncAll().then(function(res) {
			ui.addNotification(null, E('p',
				_('Sync all complete: %d synced, %d errors.')
					.format(res.synced || 0, res.errors || 0)),
				(res.errors || 0) > 0 ? 'warning' : 'info');
			if (res && res.reloaded)
				ui.addNotification(null,
					E('p', _('Active node changed — sing-box reloaded.')), 'info');
			uci.unload('treadle');
			return uci.load('treadle').then(function() {
				return self._treadleHost.remountActive();
			});
		}).catch(function() {
			ui.addNotification(null, E('p', _('Sync all failed.')), 'error');
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

		// List-typed references (urltest members, Basic server picks). UCI
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
		if (uci.get('treadle', 'basic'))
			renameInList('basic', 'server');

		if (changed > 0)
			ui.addNotification(null, E('p',
				_('Renamed "%s" to "%s" — %d routing reference(s) updated to follow.')
					.format(oldTag, newTag, changed)), 'info');
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
