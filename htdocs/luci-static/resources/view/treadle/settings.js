// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Settings tab: every UCI-backed configuration option lives here, on one
// scroll page. The form is divided into Basic (always visible) and Advanced
// (collapsed by default behind a <details> toggle). One form.Map covers all
// three UCI sections (global, inbounds, dns) so a single Save & Apply commits
// everything together — the previous five sub-tabs each had their own footer,
// which is a hopping cost the new layout removes.
//
// "Enable Treadle" is intentionally NOT in this form: the Status page owns
// the persistent enable toggle (and the transient Stop/Start/Restart
// runtime controls), so the master flag has one source of truth.
//
// Advanced overrides (/etc/treadle/extra.json) live at the bottom inside the
// same Advanced expander — they are RPC-backed rather than UCI-backed, so
// they hang off a sibling panel after the form.

'use strict';
'require baseclass';
'require dom';
'require form';
'require rpc';
'require session';
'require ui';
'require view.treadle.lib.formpanel as formpanel';

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

// SagerNet sing-box updates (decision 0153): the helper runs in the
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
			_('How LAN traffic enters sing-box: through a TUN virtual ' +
			  'interface (recommended), or transparently via TProxy. An ' +
			  'explicit HTTP/SOCKS5 listener can be added to either.'));
		oMode.value('tun',          _('TUN only — virtual L3 interface, sing-box manages routing'));
		oMode.value('tproxy',       _('TProxy only — transparent TCP + UDP via nftables'));
		oMode['default'] = 'tun';

		// Applies to both modes: firewall.sh skips the OUTPUT-chain rules in
		// tproxy, build-config excludes local uids from the tun. The UCI name
		// predates TUN support.
		var oTproxySelf = sNet.option(form.Flag, 'tproxy_self',
			_('Proxy router traffic'),
			_('Also send traffic originated by the router itself through sing-box ' +
			  '(needed for subscription / rule-set downloads when the source is blocked). ' +
			  'Disable to keep the router\'s own traffic (SSH out, opkg, ntp) direct; ' +
			  'LAN clients are still proxied.'));
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
			_('Also accept explicit HTTP and SOCKS5 proxy connections from app clients. ' +
			  'The default address is loopback; set a LAN address to expose it, ' +
			  'but the listener has no authentication.'));
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
		var oInet6 = sNet.option(form.Flag, 'inet6',
			_('Enable IPv6'), _('Proxy IPv6 traffic'));
		oInet6.rmempty = false;

		// ── DNS ──────────────────────────────────────────────────────────
		var sDns = m.section(form.NamedSection, 'dns', 'treadle', _('DNS'),
			_('DNS server selection follows your routing rules: a domain routed ' +
			  'directly resolves via the Local DNS, a proxied domain via the ' +
			  'Remote DNS. Local and reserved domains always use the on-router resolver.'));
		sDns.addremove = false;

		var oManaged = advance(sDns.option(form.Flag, 'managed_dns', _('Managed DNS'),
			_('Point dnsmasq at sing-box so all LAN clients are resolved ' +
			  'through it. When off, only clients with a hardcoded public ' +
			  'resolver are intercepted. Leave on unless you know you need ' +
			  'dnsmasq to keep resolving directly.')));
		oManaged.rmempty = false;
		oManaged.default = '1';

		var oLocal = sDns.option(form.Value, 'local_server', _('Local DNS'),
			wanDns
				? _('Resolver for directly-routed traffic and for proxy node hostnames. Pick "WAN DNS" to follow the WAN-assigned resolver (currently %s), or type an explicit address.').format(wanDns)
				: _('Resolver for directly-routed traffic and for proxy node hostnames. Pick "WAN DNS" to follow the WAN-assigned resolver, or type an explicit address.'));
		oLocal.value('wan', _('WAN DNS (auto-detected)'));
		oLocal.optional = true;
		oLocal.placeholder = 'wan';
		oLocal.validate = function(section_id, value) {
			return validateDnsAddress(value, true);
		};

		var oRemoteServer = sDns.option(form.Value, 'remote_server', _('Remote DNS'),
			_('Resolver for proxied traffic. Leave blank to use Cloudflare ' +
			  'DNS-over-TLS (tls://1.1.1.1).'));
		oRemoteServer.optional = true;
		oRemoteServer.placeholder = 'tls://1.1.1.1';
		oRemoteServer.validate = function(section_id, value) {
			return validateDnsAddress(value, false);
		};

		var oFakeipEnabled = sDns.option(form.Flag, 'fakeip_enabled',
			_('Fake-IP for proxied domains'),
			_('Resolve every proxied domain to a synthetic IP so routing happens ' +
			  'by domain without an upstream DNS round-trip. Directly-routed and ' +
			  'local domains always resolve normally.'));
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
			_('Answer from an expired cache entry at once and refresh it in the ' +
			  'background, so a repeat lookup never waits on the upstream ' +
			  'resolver. A record that has really changed is served stale once. ' +
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
		var sRulesets = m.section(form.NamedSection, 'global', 'treadle', _('Rule-sets'));
		sRulesets.addremove = false;

		var oDelivery = sRulesets.option(form.ListValue, 'ruleset_delivery',
			_('Rule-set delivery'),
			_('Where sing-box fetches the rule-sets referenced by routing rules. ' +
			  'GitHub raw, or the jsDelivr CDN for GitHub-blocked regions.'));
		oDelivery.value('github',   _('GitHub (raw)'));
		oDelivery.value('jsdelivr', _('jsDelivr CDN'));
		oDelivery['default'] = 'github';

		var oDetour = advance(sRulesets.option(form.ListValue, 'ruleset_download_detour',
			_('Rule-set download via'),
			_('How sing-box fetches rule-sets: through the default outbound ' +
			  '(the proxy) so the fetch follows the user\'s routing choice, ' +
			  'or straight out the WAN when the proxy is unreachable.')));
		oDetour.value('default', _('Default outbound (proxy)'));
		oDetour.value('direct',  _('Direct (WAN)'));
		oDetour['default'] = 'default';

		// ── Node dialling ────────────────────────────────────────────────
		// Also binds `global` (see the Rule-sets note above on sharing one
		// UCI section across several form sections — `connect_timeout` is
		// not reused as an option name anywhere else, which is what keeps
		// the per-option DOM ids unique).
		var sDial = m.section(form.NamedSection, 'global', 'treadle', _('Node dialling'));
		sDial.addremove = false;

		// Whole section is Advanced, like Logging: its
		// only field is, and tagging the row alone left an empty heading.
		// No default: an empty field is the usual case and emits nothing,
		// leaving sing-box's own 5 s. The placeholder shows that figure.
		var oConnTimeout = sDial.option(form.Value, 'connect_timeout',
			_('Connect timeout'),
			_('How long to wait for a node\'s TCP connection before giving up ' +
			  'on it. Leave empty for sing-box\'s own limit of 5 seconds; raise ' +
			  'it on a very slow link whose connection takes longer, or lower ' +
			  'it to fail over sooner. Hysteria2 and TUIC ignore it and always ' +
			  'give up after 5 seconds.'));
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

		// ── Live stats and latency testing ───────────────────────────────
		// Always visible: the flag feeds build-config's
		// experimental.clash_api emission, which the Status tab's Traffic and
		// Groups rows read as well as the Nodes tab's Test buttons. Node
		// probes themselves run on an ephemeral sing-box instance started by
		// the test runner, so the running config stays lean. Only the
		// auto-test interval is Advanced.
		var sLatency = m.section(form.NamedSection, 'global', 'treadle', _('Live stats and latency testing'));
		sLatency.addremove = false;

		var oClashApi = sLatency.option(form.Flag, 'clash_api_enabled',
			_('Enable live stats and latency testing'),
			_('Shows live traffic and the active node of each group on the ' +
			  'Status tab, and adds a Test button next to each node on the ' +
			  'Nodes tab. Uses sing-box\'s clash API, which listens on ' +
			  '127.0.0.1 only and is never exposed on the LAN.'));
		oClashApi.rmempty = false;

		var oAutoTest = advance(sLatency.option(form.Value, 'auto_test_hours',
			_('Auto-test interval (hours)'),
			_('Probe every node automatically each N hours, so the Latency ' +
			  'column stays fresh without clicking Test all. Runs from the ' +
			  'hourly maintenance tick after due subscription syncs, so newly ' +
			  'imported nodes are included. 0 disables.')));
		oAutoTest.datatype = 'uinteger';
		oAutoTest.placeholder = '0';
		oAutoTest['default'] = '0';
		oAutoTest.depends('clash_api_enabled', '1');

		// ── Logging ──────────────────────────────────────────────────────
		// Entire section is Advanced — its wrapper div gets the
		// treadle-advanced class in _postRender, so individual rows do not
		// need to be tagged via advance().
		var sLogging = m.section(form.NamedSection, 'global', 'treadle', _('Logging'));
		sLogging.addremove = false;

		var oLog = sLogging.option(form.ListValue, 'log_level',
			_('sing-box log level'),
			_('Verbosity of the sing-box service log. Info logs every connection; warning is recommended for normal use.'));
		oLog.value('error', _('Error'));
		oLog.value('warn',  _('Warning'));
		oLog.value('info',  _('Info'));
		oLog.value('debug', _('Debug'));
		oLog.default = 'warn';

		var oPLog = sLogging.option(form.ListValue, 'treadle_log_level',
			_('Treadle log level'),
			_('Which Treadle control-plane events (service / config / firewall / DNS / sync) appear in the Treadle log on the Status page. Filters display only — syslog still accumulates everything.'));
		oPLog.value('error',  _('Error'));
		oPLog.value('warning', _('Warning'));
		oPLog.value('notice', _('Notice'));
		oPLog.value('info',   _('Info'));
		oPLog.value('debug',  _('Debug'));
		oPLog.default = 'info';

		this.map = m;
		this._advOpts = advOpts;
		// Sections whose whole content is Advanced. _postRender tags their
		// wrapper div with treadle-advanced so the section header + every row
		// hides as one unit when the toggle is off.
		this._advSections = [sDial, sLogging];

		return m.render().then(L.bind(this._postRender, this, extraText));
	},

	// Tag every advanced option's row with the treadle-advanced class, install a
	// <details>-driven CSS toggle on the map root, and append the extra.json
	// editor (also tagged advanced) below the form.
	_postRender: function(extraText, formNode) {
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

		// Whole-section Advanced: walk up from the section's first option
		// row to its enclosing .cbi-section. Two NamedSections binding the
		// same UCI section share a wrapper-div id, but each option's cbid is
		// still unique, so this lookup lands on the right section.
		(this._advSections || []).forEach(function(section) {
			var opts = (section.children || []).filter(function(o) {
				return typeof o.cbid === 'function';
			});
			if (!opts.length) return;
			var firstOpt = opts[0];
			var sel = '#' + firstOpt.cbid(section.section).replace(/\./g, '\\.');
			var input = formNode.querySelector(sel);
			if (!input) return;
			var sectionEl = input.closest('.cbi-section');
			if (sectionEl) sectionEl.classList.add('treadle-advanced');
		});

		// Extra-overrides panel — same class so it hides with the rest.
		var extraSection = E('div', {
			'class': 'cbi-section treadle-advanced'
		}, [
			E('h3', {}, [ _('Raw sing-box overrides') ]),
			E('div', { 'class': 'cbi-section-descr' }, [
				_('Optional JSON object stored at /etc/treadle/extra.json. Top-level keys here shallow-merge into the generated config (arrays are replaced wholesale). Use sparingly — most settings have a dedicated field above.')
			]),
			E('textarea', {
				'id': 'treadle-extra-text',
				'class': 'cbi-input-textarea',
				'style': 'width:100%; min-height:240px; font-family:monospace; font-size:0.82em; line-height:1.4;',
				'spellcheck': 'false',
				'placeholder': '{\n  "experimental": {\n    "clash_api": { "external_controller": "127.0.0.1:9090" }\n  }\n}'
			}, [ extraText ]),
			E('div', { 'style': 'margin-top:0.5em;' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-remove',
					'style': 'margin-right:0.5em;',
					'click': ui.createHandlerFn(this, this._handleClearExtra)
				}, [ _('Clear overrides') ]),
				E('button', {
					'class': 'btn cbi-button cbi-button-save',
					'click': ui.createHandlerFn(this, this._handleSaveExtra)
				}, [ _('Save overrides') ])
			])
		]);

		// A plain checkbox + label at the top of the form — reads as a "view
		// filter" the way Gmail's "Show advanced search" does, not as a
		// section header. Lighter visual weight than the chip/bar styles
		// because that's all this control needs to do: flip a visibility
		// flag on the form below.
		var styleEl = E('style', {}, [
			// `:not(.hidden)` so a row whose depends() condition is unmet
			// (LuCI tags it with the `hidden` class — form.js line ~2095)
			// stays hidden even while Advanced is on. Without this, the
			// Show-Advanced override out-specifics `.hidden{display:none}`
			// and TUN-only / TProxy-only rows leak across modes.
			'.cbi-map .treadle-advanced{display:none}' +
			'.cbi-map.treadle-show-advanced .cbi-value.treadle-advanced:not(.hidden){display:flex}' +
			'.cbi-map.treadle-show-advanced .cbi-section.treadle-advanced{display:block}' +
			'.treadle-adv-toggle{display:inline-flex;align-items:center;gap:0.4em;' +
				'margin:0.4em 0 1em;padding:0.2em 0.4em;cursor:pointer;' +
				'font-size:0.95em;user-select:none}' +
			'.treadle-adv-toggle input{margin:0;cursor:pointer}'
		]);

		var cb = E('input', { 'type': 'checkbox' });
		var toggle = E('label', { 'class': 'treadle-adv-toggle' }, [
			cb, E('span', {}, [ _('Show all fields') ])
		]);
		// Session-persisted (same store the host uses for the active tab),
		// so power users who live in the advanced fields don't re-tick the
		// box on every visit — and it survives the Save & Apply page reload.
		if (session.getLocalData('treadle.showAdvanced') === '1') {
			cb.checked = true;
			formNode.classList.add('treadle-show-advanced');
		}
		cb.addEventListener('change', function() {
			formNode.classList.toggle('treadle-show-advanced', cb.checked);
			session.setLocalData('treadle.showAdvanced', cb.checked ? '1' : '');
		});

		formNode.insertBefore(toggle, formNode.firstChild);
		formNode.appendChild(styleEl);
		formNode.appendChild(this._renderSbuSection());
		formNode.appendChild(extraSection);

		// A check or install may already be running (another tab, or a
		// reload mid-install): pick up its progress.
		if (this._sbu.busy)
			this._sbuPoll(0);

		return formNode;
	},

	// ── sing-box version (SagerNet updates) ──────────────────────────────
	// Always visible: it is an action, not a setting. The body is rebuilt
	// from get_singbox_update on every poll.
	_renderSbuSection: function() {
		this._sbuBody = E('div', {});
		this._renderSbuBody();
		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('sing-box version') ]),
			E('div', { 'class': 'cbi-section-descr' }, [
				_('Check SagerNet\'s latest stable sing-box release for an OpenWrt package built for this router, and install it in place of the OpenWrt package. SagerNet\'s packages are not signed: Treadle checks the download against the SHA-256 that GitHub publishes for it, test-runs the binary, and returns to the OpenWrt package if the new version does not start.')
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
				ui.addNotification(null, E('p', res.error === 'busy'
					? _('A sing-box check or install is already running.')
					: _('Could not start: %s').format(res.error)), 'error');
				return;
			}
			self._sbu = Object.assign({}, self._sbu, { busy: true, step: _('Starting…'), error: null, message: null });
			self._renderSbuBody();
			self._sbuPoll(since);
		}).catch(function(e) {
			ui.addNotification(null, E('p', _('Could not start: %s').format(e.message || e)), 'error');
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

	_handleSaveExtra: function() {
		var el = document.getElementById('treadle-extra-text');
		if (!el) return;
		var raw = el.value || '';
		var isEmpty = (raw.match(/^\s*$/) !== null);
		if (!isEmpty) {
			try {
				var parsed = JSON.parse(raw);
				if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
					ui.addNotification(null, E('p', _('Overrides must be a JSON object.')), 'error');
					return;
				}
			} catch (e) {
				ui.addNotification(null, E('p', _('Invalid JSON: ') + e.message), 'error');
				return;
			}
		}
		return callSetExtraConfig(raw).then(function(res) {
			if (res && res.ok === false) {
				ui.addNotification(null, E('p', res.error || _('Save failed.')), 'error');
				return;
			}
			// The backend deletes the file when raw is whitespace-only;
			// tell the user that explicitly so they don't think they
			// just saved something when they actually cleared overrides
			// by hitting Save on a blank textarea.
			ui.addNotification(null, E('p',
				isEmpty
					? _('Overrides cleared.')
					: _('Overrides saved. Regenerate to see them applied.')),
				'info');
		}).catch(function() {
			ui.addNotification(null, E('p', _('Save failed.')), 'error');
		});
	},

	_handleClearExtra: function() {
		if (!confirm(_('Clear /etc/treadle/extra.json?'))) return;
		return callSetExtraConfig('').then(function() {
			var el = document.getElementById('treadle-extra-text');
			if (el) el.value = '';
			ui.addNotification(null, E('p', _('Overrides cleared.')), 'info');
		}).catch(function() {
			ui.addNotification(null, E('p', _('Clear failed.')), 'error');
		});
	},

	handleSave:      function() { return formpanel.save(this); },
	handleSaveApply: function() { return formpanel.saveApply(this); },
	handleReset:     function() { return formpanel.reset(this); }
});
