// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Settings tab: every UCI-backed configuration option lives here, on one
// scroll page, grouped by purpose: Network, DNS, Nodes, Rule-sets, Logging
// and Advanced. Fields most people never touch sit behind a per-section
// "More options (n)" toggle. One form.Map covers all three UCI sections
// (global, inbounds, dns) so a single Save & Apply commits everything.
//
// "Enable Treadle" is intentionally NOT in this form: the Status page owns
// the persistent enable toggle (and the transient Stop/Start/Restart
// runtime controls), so the master flag has one source of truth.
//
// The raw sing-box overrides (/etc/treadle/extra.json) are RPC-backed, not
// UCI-backed, but they save with the same Save / Save & Apply as the form
// (handleSave below) — one way to save on the page. The sing-box version
// card acts immediately, so it sits apart, below the save bar.

'use strict';
'require baseclass';
'require dom';
'require form';
'require rpc';
'require session';
'require ui';
'require view.treadle.lib.formpanel as formpanel';
'require view.treadle.lib.notify as notify';

var callGetWanDns = rpc.declare({
	object: 'luci.treadle',
	method: 'get_wan_dns',
	expect: { '': {} }
});

var callGetExtraConfig = rpc.declare({
	object: 'luci.treadle',
	method: 'get_extra_config',
	expect: { '': {} }
});

var callSetExtraConfig = rpc.declare({
	object: 'luci.treadle',
	method: 'set_extra_config',
	params: ['payload'],
	expect: { '': {} }
});

// SagerNet sing-box updates: the helper runs in the
// background and get_singbox_update reports its progress.
var callGetSingboxUpdate = rpc.declare({
	object: 'luci.treadle',
	method: 'get_singbox_update',
	expect: { '': {} }
});

var callCheckSingboxUpdate = rpc.declare({
	object: 'luci.treadle',
	method: 'check_singbox_update',
	expect: { '': {} }
});

var callInstallSingboxUpdate = rpc.declare({
	object: 'luci.treadle',
	method: 'install_singbox_update',
	params: ['version'],
	expect: { '': {} }
});

var callRevertSingboxPackage = rpc.declare({
	object: 'luci.treadle',
	method: 'revert_singbox_package',
	expect: { '': {} }
});

function formatMB(bytes) {
	return (bytes / 1048576).toFixed(1) + ' MB';
}

// DNS address validator — mirrors build-config's parse_dns_url. An optional
// scheme, a host that is a valid IP or hostname, an optional port, and an
// optional /path for https/h3. Rejecting malformed input here stops a value
// like "tls://1" from reaching sing-box, which aborts on it at startup.
function isIPv4(s) {
	var m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m)
		return false;
	for (var i = 1; i <= 4; i++)
		if (+m[i] > 255)
			return false;
	return true;
}

function isIPv6(s) {
	return /^[0-9A-Fa-f:]+$/.test(s) && (s.match(/:/g) || []).length >= 2;
}

function isHostname(s) {
	return /[A-Za-z]/.test(s) &&
		/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(s);
}

function validateDnsAddress(value, allowWan) {
	var v = String(value == null ? '' : value).trim();
	if (v === '')
		return true;
	if (allowWan && v === 'wan')
		return true;

	var rest = v, scheme = null;
	var m = v.match(/^([a-z0-9]+):\/\/(.+)$/);
	if (m) {
		scheme = m[1];
		rest = m[2];
	}
	if (scheme !== null && !/^(udp|tcp|tls|https|quic|h3)$/.test(scheme))
		return _('Unsupported scheme "%s" (use udp, tcp, tls, https, quic or h3)').format(scheme);

	rest = rest.replace(/\/.*$/, '');
	if (rest === '')
		return _('Missing server address');

	var b = rest.match(/^\[([0-9A-Fa-f:]+)\](?::\d+)?$/);
	if (b)
		return isIPv6(b[1]) ? true : _('Invalid IPv6 address');

	var hp = rest.match(/^(.+):(\d+)$/);
	var host = hp ? hp[1] : rest;
	if (host === '')
		return _('Missing server address');
	if (isIPv4(host) || isIPv6(host) || isHostname(host))
		return true;
	return _('"%s" is not a valid IP address or hostname').format(host);
}

return baseclass.extend({
	load: function() {
		// A failed RPC must not blank the tab — degrade to empty data.
		return Promise.all([
			callGetWanDns().catch(function() { return {}; }),
			callGetExtraConfig().catch(function() { return {}; }),
			callGetSingboxUpdate().catch(function() { return {}; })
		]);
	},

	render: function(results) {
		var wanDnsInfo = (results && results[0]) || {};
		var extraData  = (results && results[1]) || {};
		this._sbu      = (results && results[2]) || {};
		var wanDns     = wanDnsInfo.wan_dns || null;
		var extraText  = extraData.json || '';

		var m = new form.Map('treadle');

		// Collect option objects that should live behind the Advanced expander.
		// After m.render(), each option's input id is `cbid.treadle.<section>.<name>`
		// and the wrapping .cbi-value row gets a class added so a CSS toggle on
		// the map root can show/hide them as a group.
		var advOpts = [];

		function advance(opt) {
			advOpts.push(opt);
			return opt;
		}

		// ── Network ──────────────────────────────────────────────────────
		var sNet = m.section(form.NamedSection, 'inbounds', 'treadle', _('Network'));
		sNet.addremove = false;

		var oMode = sNet.option(form.ListValue, 'mode', _('Mode'),
			_('How LAN traffic reaches sing-box.'));
		oMode.value('tun',          _('TUN — virtual interface (recommended)'));
		oMode.value('tproxy',       _('TProxy — transparent TCP + UDP via nftables'));
		oMode['default'] = 'tun';

		// Applies to both modes: firewall.sh skips the OUTPUT-chain rules in
		// tproxy, build-config excludes local uids from the tun. The UCI name
		// predates TUN support.
		var oTproxySelf = sNet.option(form.Flag, 'tproxy_self',
			_('Proxy router traffic'),
			_('Also send the router\'s own traffic (opkg, NTP, subscription and ' +
			  'rule-set downloads) through sing-box. Off keeps it direct; LAN ' +
			  'clients are still proxied.'));
		oTproxySelf['default'] = '1';
		oTproxySelf.rmempty = false;

		// tproxy group — sits directly below Mode so the
		// mode-dependent rows are visually adjacent to the selector that
		// reveals them.
		var oTproxyPort = advance(sNet.option(form.Value, 'tproxy_port', _('TProxy port')));
		oTproxyPort.datatype = 'port';
		oTproxyPort.placeholder = '7895';
		oTproxyPort.depends('mode', 'tproxy');

		var oMixedEnabled = sNet.option(form.Flag, 'mixed_enabled',
			_('HTTP/SOCKS5 listener'),
			_('Also accept explicit proxy connections from apps. It has no ' +
			  'authentication, so keep it on loopback unless you need it on the LAN.'));
		oMixedEnabled['default'] = '0';
		oMixedEnabled.rmempty = false;
		oMixedEnabled.depends('mode', 'tun');
		oMixedEnabled.depends('mode', 'tproxy');

		var oMixedListen = advance(sNet.option(form.Value, 'mixed_listen', _('Mixed listen address')));
		oMixedListen.placeholder = '127.0.0.1';
		oMixedListen.depends('mixed_enabled', '1');

		var oMixedPort = advance(sNet.option(form.Value, 'mixed_port', _('Mixed port')));
		oMixedPort.datatype = 'port';
		oMixedPort.placeholder = '2080';
		oMixedPort.depends('mixed_enabled', '1');

		// tun only group
		var oTunAddr = advance(sNet.option(form.Value, 'tun_address', _('TUN IPv4 address')));
		oTunAddr.placeholder = '172.19.0.1/30';
		oTunAddr.depends('mode', 'tun');

		var oTunMtu = advance(sNet.option(form.Value, 'tun_mtu', _('TUN MTU')));
		oTunMtu.datatype = 'uinteger';
		oTunMtu.placeholder = '9000';
		oTunMtu.depends('mode', 'tun');

		var oTunStack = advance(sNet.option(form.ListValue, 'tun_stack', _('TUN stack')));
		oTunStack.value('system', 'system');
		oTunStack.value('gvisor', 'gvisor');
		oTunStack.value('mixed',  'mixed');
		oTunStack['default'] = 'system';
		oTunStack.depends('mode', 'tun');

		var oTunAutoRoute = advance(sNet.option(form.Flag, 'tun_auto_route',
			_('Auto-route'), _('Set system routes to capture all traffic')));
		oTunAutoRoute['default'] = '1';
		oTunAutoRoute.rmempty = false;
		oTunAutoRoute.depends('mode', 'tun');

		// always-visible Network options at the bottom of the section
		var oInet6 = sNet.option(form.Flag, 'inet6', _('Proxy IPv6 traffic'));
		oInet6.rmempty = false;

		// ── DNS ──────────────────────────────────────────────────────────
		var sDns = m.section(form.NamedSection, 'dns', 'treadle', _('DNS'),
			_('Domains routed direct use the first resolver, proxied ones the ' +
			  'second; local names always use the router.'));
		sDns.addremove = false;

		var oManaged = advance(sDns.option(form.Flag, 'managed_dns', _('Managed DNS'),
			_('Point the router\'s resolver (dnsmasq) at sing-box so every LAN ' +
			  'client follows the rules. Off, only clients with a hard-coded ' +
			  'public resolver are intercepted.')));
		oManaged.rmempty = false;
		oManaged.default = '1';

		var oLocal = sDns.option(form.Value, 'local_server', _('DNS for direct traffic'),
			wanDns
				? _('Also resolves node host names. "WAN DNS" follows the resolver your WAN assigns (now %s).').format(wanDns)
				: _('Also resolves node host names. "WAN DNS" follows the resolver your WAN assigns.'));
		oLocal.value('wan', _('WAN DNS (auto-detected)'));
		oLocal.optional = true;
		oLocal.placeholder = 'wan';
		oLocal.validate = function(section_id, value) {
			return validateDnsAddress(value, true);
		};

		var oRemoteServer = sDns.option(form.Value, 'remote_server', _('DNS for proxied traffic'),
			_('Reached through the proxy. Empty uses Cloudflare DNS-over-TLS ' +
			  '(tls://1.1.1.1).'));
		oRemoteServer.optional = true;
		oRemoteServer.placeholder = 'tls://1.1.1.1';
		oRemoteServer.validate = function(section_id, value) {
			return validateDnsAddress(value, false);
		};

		var oFakeipEnabled = sDns.option(form.Flag, 'fakeip_enabled',
			_('Fake-IP for proxied domains'),
			_('Answer proxied domains with a placeholder address, so routing ' +
			  'needs no upstream lookup. Direct and local domains resolve normally.'));
		oFakeipEnabled.rmempty = false;

		var oStrategy = advance(sDns.option(form.ListValue, 'strategy', _('Strategy')));
		oStrategy.value('',           _('default'));
		oStrategy.value('prefer_ipv4', 'prefer_ipv4');
		oStrategy.value('prefer_ipv6', 'prefer_ipv6');
		oStrategy.value('ipv4_only',   'ipv4_only');
		oStrategy.value('ipv6_only',   'ipv6_only');
		oStrategy.optional = true;

		var oFakeipV4 = advance(sDns.option(form.Value, 'fakeip_range_v4', _('Fake-IP IPv4 range')));
		oFakeipV4.placeholder = '198.18.0.0/15';
		oFakeipV4.datatype = 'cidr4';
		oFakeipV4.depends('fakeip_enabled', '1');

		var oFakeipV6 = advance(sDns.option(form.Value, 'fakeip_range_v6', _('Fake-IP IPv6 range')));
		oFakeipV6.placeholder = 'fc00::/18';
		oFakeipV6.datatype = 'cidr6';
		oFakeipV6.depends('fakeip_enabled', '1');

		var oOptimistic = advance(sDns.option(form.Flag, 'optimistic',
			_('Optimistic DNS cache'),
			_('Answer from an expired entry at once and refresh it in the ' +
			  'background. A record that really changed is served stale once. ' +
			  'Needs sing-box 1.14 or later.')));
		oOptimistic.rmempty = false;

		// No default: empty emits no timeout, leaving sing-box's own 3 days.
		var oOptimisticTimeout = advance(sDns.option(form.Value, 'optimistic_timeout',
			_('Optimistic cache window'),
			_('How long past its TTL an entry may still be served. Leave empty ' +
			  'for sing-box\'s own 3 days (72h).')));
		oOptimisticTimeout.placeholder = '72h';
		oOptimisticTimeout.optional    = true;
		oOptimisticTimeout.depends('optimistic', '1');
		oOptimisticTimeout.validate = function(section_id, value) {
			if (value == null || value === '')
				return true;
			if (!/^(\d+(\.\d+)?(ns|us|ms|s|m|h))+$/.test(value))
				return _('Expected a duration such as "1h" or "24h"');
			return true;
		};

		// ── Rule-sets ────────────────────────────────────────────────────
		// Two visually distinct sections (Rule-sets, Logging) both bind to
		// the same `global` UCI section. The only DOM-id collision this
		// causes is the wrapper div's `cbi-treadle-global` — every per-option
		// id (`cbid.treadle.global.<name>`) stays unique as long as no option
		// name is reused across the two sections, which form save/load,
		// validation and getUIElement rely on, not the wrapper id.
		var sRulesets = m.section(form.NamedSection, 'global', 'treadle', _('Rule-sets'),
			_('Where the rule-sets your rules reference come from.'));
		sRulesets.addremove = false;

		var oDelivery = sRulesets.option(form.ListValue, 'ruleset_delivery',
			_('Delivery'),
			_('GitHub, or the jsDelivr CDN where GitHub is blocked.'));
		oDelivery.value('github',   _('GitHub (raw)'));
		oDelivery.value('jsdelivr', _('jsDelivr CDN'));
		oDelivery['default'] = 'github';

		var oDetour = advance(sRulesets.option(form.ListValue, 'ruleset_download_detour',
			_('Download via'),
			_('Through the default node, or direct over the WAN, which avoids ' +
			  'a failed first download when the proxy is down at start-up.')));
		oDetour.value('default', _('Default node (proxy)'));
		oDetour.value('direct',  _('Direct (WAN)'));
		oDetour['default'] = 'default';

		// ── Nodes ────────────────────────────────────────────────────────
		// Live stats, latency tests and how long a node gets to answer. Binds
		// `global` like Rule-sets (see the note there on sharing one UCI
		// section across several form sections). The flag feeds
		// build-config's experimental.clash_api, which the Status tab's
		// traffic, nodes in use and connectivity check read, as do the Nodes
		// tab's Test buttons. Node probes run on an ephemeral sing-box started
		// by the test runner, so the running config stays lean.
		var sNodes = m.section(form.NamedSection, 'global', 'treadle', _('Nodes'),
			_('Live stats, latency tests and how long a node gets to answer.'));
		sNodes.addremove = false;

		var oClashApi = sNodes.option(form.Flag, 'clash_api_enabled',
			_('Live stats and latency testing'),
			_('Traffic, nodes in use and the connectivity check on Status; Test ' +
			  'buttons on Nodes. Uses sing-box\'s clash API, which listens on ' +
			  '127.0.0.1 only.'));
		oClashApi.rmempty = false;

		var oAutoTest = advance(sNodes.option(form.Value, 'auto_test_hours',
			_('Auto-test interval (hours)'),
			_('Test every node every N hours, after due subscription syncs. 0 turns it off.')));
		oAutoTest.datatype = 'uinteger';
		oAutoTest.placeholder = '0';
		oAutoTest['default'] = '0';
		oAutoTest.depends('clash_api_enabled', '1');

		// No default: an empty field is the usual case and emits nothing,
		// leaving sing-box's own 5 s. The placeholder shows that figure.
		var oConnTimeout = advance(sNodes.option(form.Value, 'connect_timeout',
			_('Connect timeout'),
			_('How long a node\'s connection may take before Treadle gives up on ' +
			  'it. Empty uses sing-box\'s own 5 s. Hysteria2 and TUIC always use 5 s.')));
		oConnTimeout.placeholder = '5s';
		oConnTimeout.optional    = true;
		oConnTimeout.validate = function(section_id, value) {
			if (value == null || value === '' || value === '0')
				return true;
			// Go duration: one or more <number><unit> pairs, e.g. 5s, 1m30s.
			if (!/^(\d+(\.\d+)?(ns|us|ms|s|m|h))+$/.test(value))
				return _('Expected a duration such as "8s" or "1m30s"');
			return true;
		};

		// ── Logging ──────────────────────────────────────────────────────
		var sLogging = m.section(form.NamedSection, 'global', 'treadle', _('Logging'));
		sLogging.addremove = false;

		var oLog = sLogging.option(form.ListValue, 'log_level',
			_('sing-box log level'),
			_('Info logs every connection; warning suits normal use.'));
		oLog.value('error', _('Error'));
		oLog.value('warn',  _('Warning'));
		oLog.value('info',  _('Info'));
		oLog.value('debug', _('Debug'));
		oLog.default = 'warn';

		var oPLog = sLogging.option(form.ListValue, 'treadle_log_level',
			_('Treadle log level'),
			_('Which Treadle events the Status tab shows. The system log keeps everything.'));
		oPLog.value('error',  _('Error'));
		oPLog.value('warning', _('Warning'));
		oPLog.value('notice', _('Notice'));
		oPLog.value('info',   _('Info'));
		oPLog.value('debug',  _('Debug'));
		oPLog.default = 'info';

		this.map = m;
		this._advOpts = advOpts;
		// The sections, in page order, with the key their "More options"
		// state is remembered under.
		this._sections = [ [ sNet, 'network' ], [ sDns, 'dns' ], [ sNodes, 'nodes' ],
			[ sRulesets, 'rulesets' ], [ sLogging, 'logging' ] ];
		this._extraSaved = extraText;
		this._extraEl = null;

		// LuCI rebuilds the form's contents on render, on Save and on Reset
		// (Map.save and Map.reset both end in renderContents), which drops
		// everything added after it. Hook that step so the toggles and the
		// Advanced section are added again after every rebuild.
		var self = this;
		var renderContents = m.renderContents;
		m.renderContents = function() {
			return renderContents.apply(this, arguments).then(function(node) {
				return self._decorate(node);
			});
		};

		return m.render().then(function(node) {
			// A check or install may already be running (another tab, or a
			// reload mid-install): pick up its progress.
			if (self._sbu.busy)
				self._sbuPoll(0);
			return node;
		});
	},

	// Tag each advanced option's row, give every section with such rows its
	// own "More options (n)" toggle, and add the Advanced section with the
	// raw overrides below the form. Runs after every rebuild of the form.
	_decorate: function(formNode) {
		var self = this;
		// Each NamedSection-bound option's input id is
		// `cbid.treadle.<sectionname>.<optionname>`. Find it and walk up to the
		// wrapping `.cbi-value` row. Depends-hidden rows still have a DOM
		// node (just hidden) so the class lands; if a row is somehow absent
		// (e.g. option not rendered at all), the lookup quietly skips it.
		this._advOpts.forEach(function(opt) {
			var sel = '#' + opt.cbid(opt.section.section).replace(/\./g, '\\.');
			var input = formNode.querySelector(sel);
			if (!input) return;
			var row = input.closest('.cbi-value');
			if (row) row.classList.add('treadle-advanced');
		});

		// Which sections are open is remembered in the browser, like the
		// active tab, so it survives the Save & Apply reload.
		var open = session.getLocalData('treadle.settingsOpen') || {};
		var save = function() { session.setLocalData('treadle.settingsOpen', open); };
		var toggles = [];

		// Several sections bind the same UCI section (`global`) and share a
		// wrapper id, but each option's cbid is unique, so walking up from a
		// section's first option finds the right section element.
		this._sections.forEach(function(pair) {
			var section = pair[0], key = pair[1];
			var opts = (section.children || []).filter(function(o) {
				return typeof o.cbid === 'function';
			});
			if (!opts.length) return;
			var input = formNode.querySelector('#' + opts[0].cbid(section.section).replace(/\./g, '\\.'));
			var sectionEl = input && input.closest('.cbi-section');
			if (!sectionEl || !sectionEl.querySelector('.treadle-advanced')) return;
			var btn = E('button', {
				'type': 'button',
				'class': 'treadle-more',
				'click': function() {
					open[key] = !open[key];
					save();
					sectionEl.classList.toggle('treadle-open', !!open[key]);
					update();
				}
			});
			// The count is of the rows this mode can show: a TProxy-only
			// field does not count while TUN is selected.
			var update = function() {
				var n = sectionEl.querySelectorAll('.cbi-value.treadle-advanced:not(.hidden)').length;
				btn.textContent = open[key] ? _('▾ Fewer options')
					: _('▸ More options (%d)').format(n);
				btn.setAttribute('aria-expanded', open[key] ? 'true' : 'false');
				btn.style.display = n ? '' : 'none';
			};
			sectionEl.classList.toggle('treadle-open', !!open[key]);
			sectionEl.appendChild(btn);
			toggles.push(update);
			update();
		});
		// A field that shows or hides others (Mode, Fake-IP…) changes the
		// counts; LuCI applies depends() after the change event, so re-count
		// one tick later. The map element survives rebuilds, so the listener
		// is added once and reads the current set of toggles.
		this._toggles = toggles;
		if (!formNode._treadleCounts) {
			formNode._treadleCounts = true;
			formNode.addEventListener('change', function() {
				window.setTimeout(function() {
					(self._toggles || []).forEach(function(u) { u(); });
				}, 0);
			});
		}

		// ── Advanced: raw sing-box overrides ──────────────────────────────
		// Saved with the page's Save / Save & Apply (see handleSave), so the
		// page has one way to save; the JSON is checked first. A rebuild keeps
		// whatever the box holds (Reset puts the saved text back first).
		var extraText = this._extraEl ? this._extraEl.value : (this._extraSaved || '');
		this._extraErr = E('div', { 'class': 'alert-message danger', 'style': 'display:none; margin-top:0.4em;' });
		this._extraEl = E('textarea', {
			'id': 'treadle-extra-text',
			'class': 'cbi-input-textarea',
			'style': 'width:100%; min-height:200px; font-family:monospace; font-size:0.82em; line-height:1.4;',
			'spellcheck': 'false',
			'aria-label': _('Raw sing-box overrides'),
			'placeholder': '{\n  "log": { "timestamp": true }\n}'
		}, [ extraText ]);
		var extraBody = E('div', { 'class': 'treadle-extra-body' }, [
			this._extraEl,
			this._extraErr,
			E('div', { 'class': 'cbi-value-description', 'style': 'margin-top:0.4em;' }, [
				_('A JSON object merged over the generated config: its top-level keys replace Treadle\'s, arrays included. Stored as /etc/treadle/extra.json, checked when you save. Empty removes it.')
			])
		]);
		var advEl = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('Advanced') ]),
			E('div', { 'class': 'cbi-section-descr' }, [ _('For settings with no field above.') ]),
			extraBody
		]);
		var advBtn = E('button', {
			'type': 'button',
			'class': 'treadle-more',
			'click': function() {
				open.advanced = !open.advanced;
				save();
				showAdv();
			}
		});
		this._showExtra = function() {
			open.advanced = true;
			save();
			showAdv();
		};
		var showAdv = function() {
			extraBody.style.display = open.advanced ? '' : 'none';
			advBtn.textContent = open.advanced ? _('▾ Hide raw sing-box overrides')
				: _('▸ Show raw sing-box overrides');
			advBtn.setAttribute('aria-expanded', open.advanced ? 'true' : 'false');
		};
		// Overrides already in place stay visible: hiding them would hide a
		// setting that is in effect.
		if (extraText.replace(/\s/g, '') !== '' && extraText.replace(/\s/g, '') !== '{}')
			open.advanced = true;
		advEl.insertBefore(advBtn, extraBody);
		showAdv();

		formNode.appendChild(E('style', {}, [
			// `:not(.hidden)` so a row whose depends() condition is unmet
			// (LuCI tags it `hidden`) stays hidden even in an open section.
			'.cbi-map .cbi-value.treadle-advanced{display:none}' +
			'.cbi-map .cbi-section.treadle-open .cbi-value.treadle-advanced:not(.hidden){display:flex}' +
			'.treadle-more{background:none;border:0;padding:0.3em 0;margin:0.2em 0 0.4em;' +
				'color:var(--link-color, #3b8fd6);cursor:pointer;font-size:0.95em}'
		]));
		formNode.appendChild(advEl);
		return formNode;
	},

	// The sing-box version card, which acts immediately: the host puts it
	// below the save bar, apart from the settings it does not save with.
	renderBelowFooter: function() {
		return this._renderSbuSection();
	},

	// ── sing-box version (SagerNet updates) ──────────────────────────────
	// Always visible: it is an action, not a setting. The body is rebuilt
	// from get_singbox_update on every poll.
	_renderSbuSection: function() {
		this._sbuBody = E('div', {});
		this._renderSbuBody();
		return E('div', {
			'class': 'cbi-section',
			'style': 'margin-top:1.5em; padding:0.8em 1.2em; border:1px solid rgba(128,128,128,0.4); border-radius:6px; background:rgba(128,128,128,0.06);'
		}, [
			E('h3', { 'style': 'display:flex; align-items:center; gap:0.6em;' }, [
				_('sing-box version'),
				E('span', { 'class': 'label', 'style': 'text-transform:none; font-size:0.65em;' }, [ _('acts immediately') ])
			]),
			E('div', { 'class': 'cbi-section-descr' }, [
				_('Installs SagerNet\'s latest stable OpenWrt package in place of OpenWrt\'s. SagerNet\'s packages are not signed: the download is checked against the SHA-256 GitHub publishes, test-run, and replaced by the OpenWrt package again if it does not start. Not part of Save & Apply.')
			]),
			this._sbuBody
		]);
	},

	_renderSbuBody: function() {
		var st = this._sbu || {};
		var cur = st.current || {};
		var latest = st.latest || null;
		var busy = !!st.busy;

		function row(label, value) {
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, [ label ]),
				E('div', { 'class': 'cbi-value-field', 'style': 'padding-top:0.4em;' }, value)
			]);
		}

		var source = cur.source === 'sagernet' ? _('SagerNet package')
			: cur.source === 'openwrt' ? _('OpenWrt package') : _('unknown package');
		var installed = cur.version
			? _('%s (%s)').format(cur.version, source)
			: _('not found');

		var latestCell;
		if (!latest) {
			latestCell = [ _('Not checked yet.') ];
		} else {
			var bits = [ latest.version ];
			if (latest.published_at)
				bits.push(String(latest.published_at).substring(0, 10));
			if (latest.asset && latest.asset.size)
				bits.push(formatMB(latest.asset.size));
			latestCell = [ bits.join(' · ') ];
			if (latest.notes_url)
				latestCell.push(' — ', E('a', {
					'href': latest.notes_url, 'target': '_blank', 'rel': 'noreferrer'
				}, [ _('release notes') ]));
		}

		var msg = null;
		if (busy)
			msg = E('p', {}, [ E('em', { 'class': 'spinning' }, [ st.step || _('Working…') ]) ]);
		else if (st.state === 'error' && st.error)
			msg = E('div', { 'class': 'alert-message warning' }, [ st.error ]);
		else if (st.message)
			msg = E('p', {}, [ st.message ]);
		else if (latest && !st.newer && latest.asset)
			msg = E('p', {}, [ _('The installed sing-box is up to date.') ]);

		var buttons = [
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'disabled': busy ? '' : null,
				'click': ui.createHandlerFn(this, this._handleSbuCheck)
			}, [ _('Check for updates') ])
		];
		if (latest && st.newer && latest.asset)
			buttons.push(' ', E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'disabled': busy ? '' : null,
				'click': ui.createHandlerFn(this, this._handleSbuInstall, latest)
			}, [ _('Install %s').format(latest.version) ]));
		if (cur.source === 'sagernet')
			buttons.push(' ', E('button', {
				'class': 'btn cbi-button cbi-button-remove',
				'disabled': busy ? '' : null,
				'click': ui.createHandlerFn(this, this._handleSbuRevert)
			}, [ _('Return to the OpenWrt package') ]));

		dom.content(this._sbuBody, [
			row(_('Installed'), [ installed ]),
			row(_('Latest stable'), latestCell),
			msg ? row('', [ msg ]) : '',
			row('', buttons)
		]);
	},

	// Poll get_singbox_update until the helper reports a finished state newer
	// than `since` (seconds; 0 = just follow the current run). A single
	// rescheduled setTimeout, never an interval.
	_sbuPoll: function(since) {
		var self = this;
		window.clearTimeout(this._sbuTimer);
		this._sbuTimer = window.setTimeout(function() {
			callGetSingboxUpdate().then(function(st) {
				st = st || {};
				// Until the helper writes its first update, the file still
				// shows the previous run. Give it 30 s to start.
				if (since && !((st.updated_at || 0) >= since)) {
					if (Date.now() / 1000 - since < 30) {
						st.busy = true;
					} else {
						st.busy = false;
						st.state = 'error';
						st.error = _('The update helper did not start. See the system log.');
					}
				}
				self._sbu = st;
				self._renderSbuBody();
				if (st.busy)
					self._sbuPoll(since);
			}).catch(function() {
				self._sbuPoll(since);
			});
		}, 2000);
	},

	_sbuStart: function(promise) {
		var self = this;
		var since = Math.floor(Date.now() / 1000);
		return promise.then(function(res) {
			if (res && res.error) {
				notify.error(res.error === 'busy'
					? _('A sing-box check or install is already running.')
					: _('Could not start: %s').format(res.error));
				return;
			}
			self._sbu = Object.assign({}, self._sbu, { busy: true, step: _('Starting…'), error: null, message: null });
			self._renderSbuBody();
			self._sbuPoll(since);
		}).catch(function(e) {
			notify.error(_('Could not start: %s').format(e.message || e));
		});
	},

	_handleSbuCheck: function() {
		return this._sbuStart(callCheckSingboxUpdate());
	},

	_handleSbuInstall: function(latest) {
		if (!confirm(_('Install sing-box %s from SagerNet?\n\nThe package (%s) is downloaded from GitHub, checked against its published SHA-256 and installed in place of the current package. Treadle restarts on the new version, so traffic pauses briefly; if it does not start, the OpenWrt package is reinstalled.')
				.format(latest.version, latest.asset && latest.asset.size ? formatMB(latest.asset.size) : '?')))
			return;
		return this._sbuStart(callInstallSingboxUpdate(latest.version));
	},

	_handleSbuRevert: function() {
		if (!confirm(_('Return to the OpenWrt feed\'s sing-box package?\n\nThe SagerNet package is replaced by the version in the OpenWrt feed, which may be older, and Treadle restarts on it.')))
			return;
		return this._sbuStart(callRevertSingboxPackage());
	},

	// Write extra.json when the box changed, after checking it is a JSON
	// object. Resolves true to go on with the form save, false to stop.
	_saveExtra: function() {
		var self = this;
		var el = this._extraEl;
		if (!el) return Promise.resolve(true);
		var raw = el.value || '';
		var errEl = this._extraErr;
		// Shown under the box, which is where the user is looking (LuCI's
		// notifications appear at the top of the page), as well as up there.
		var fail = function(msg) {
			if (self._showExtra) self._showExtra();
			if (errEl) {
				errEl.textContent = msg;
				errEl.style.display = '';
				el.scrollIntoView({ block: 'center' });
			}
			notify.error(msg);
			return false;
		};
		if (errEl) errEl.style.display = 'none';
		if (raw === this._extraSaved) return Promise.resolve(true);
		if (!/^\s*$/.test(raw)) {
			var parsed;
			try { parsed = JSON.parse(raw); }
			catch (e) {
				return Promise.resolve(fail(_('Raw sing-box overrides: invalid JSON: %s. Nothing was saved.').format(e.message)));
			}
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
				return Promise.resolve(fail(_('Raw sing-box overrides must be a JSON object. Nothing was saved.')));
		}
		return callSetExtraConfig(raw).then(function(res) {
			if (res && res.ok === false)
				return fail(_('Raw sing-box overrides: %s').format(res.error || _('save failed')));
			self._extraSaved = raw;
			return true;
		}).catch(function() {
			return fail(_('Raw sing-box overrides: save failed.'));
		});
	},

	// Save and Save & Apply write the overrides first, then the form; a bad
	// override stops both, so nothing is half-saved.
	handleSave: function() {
		var self = this;
		return this._saveExtra().then(function(ok) {
			if (ok) return formpanel.save(self);
		});
	},
	handleSaveApply: function() {
		var self = this;
		return this._saveExtra().then(function(ok) {
			if (ok) return formpanel.saveApply(self);
		});
	},
	handleReset: function() {
		if (this._extraEl) this._extraEl.value = this._extraSaved || '';
		if (this._extraErr) this._extraErr.style.display = 'none';
		return formpanel.reset(this);
	}
});
