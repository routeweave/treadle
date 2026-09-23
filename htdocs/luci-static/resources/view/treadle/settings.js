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
			callGetExtraConfig().catch(function() { return {}; })
		]);
	},

	render: function(results) {
		var wanDnsInfo = (results && results[0]) || {};
		var extraData  = (results && results[1]) || {};
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
			_('How LAN traffic enters sing-box: transparently via TProxy ' +
			  '(recommended), via a TUN virtual interface, or both TProxy ' +
			  'plus an explicit HTTP/SOCKS5 listener for app clients.'));
		oMode.value('tproxy',       _('TProxy only — transparent TCP + UDP via nftables'));
		oMode.value('tun',          _('TUN only — virtual L3 interface, sing-box manages routing'));
		oMode.value('tproxy_mixed', _('TProxy + Mixed — transparent proxy and explicit HTTP/SOCKS5'));
		oMode['default'] = 'tproxy';

		// tproxy / tproxy_mixed group — sits directly below Mode so the
		// mode-dependent rows are visually adjacent to the selector that
		// reveals them.
		var oTproxySelf = sNet.option(form.Flag, 'tproxy_self',
			_('Proxy router traffic'),
			_('Also send traffic originated by the router itself through sing-box ' +
			  '(needed for subscription / rule-set downloads when the source is blocked). ' +
			  'Disable only to keep admin traffic (SSH out, opkg, ntp) untunneled for debugging.'));
		oTproxySelf['default'] = '1';
		oTproxySelf.rmempty = false;
		oTproxySelf.depends('mode', 'tproxy');
		oTproxySelf.depends('mode', 'tproxy_mixed');

		var oTproxyPort = advance(sNet.option(form.Value, 'tproxy_port', _('TProxy port')));
		oTproxyPort.datatype = 'port';
		oTproxyPort.placeholder = '7895';
		oTproxyPort.depends('mode', 'tproxy');
		oTproxyPort.depends('mode', 'tproxy_mixed');

		// tproxy_mixed only group
		var oMixedListen = advance(sNet.option(form.Value, 'mixed_listen', _('Mixed listen address')));
		oMixedListen.placeholder = '127.0.0.1';
		oMixedListen.depends('mode', 'tproxy_mixed');

		var oMixedPort = advance(sNet.option(form.Value, 'mixed_port', _('Mixed port')));
		oMixedPort.datatype = 'port';
		oMixedPort.placeholder = '2080';
		oMixedPort.depends('mode', 'tproxy_mixed');

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
		var sDial = m.section(form.NamedSection, 'global', 'treadle', _('Node dialling'),
			_('How long to wait for a node to answer before giving up on it ' +
			  'and moving on.'));
		sDial.addremove = false;

		// Clearing the field removes the option, and so does typing the
		// default back in — form.js calls remove() for both — so an emptied
		// box means "shipped default", not "no limit". `0` is the opt-out,
		// which is why the description names it rather than saying "leave
		// empty". build-config reads the two states the same way.
		var oConnTimeout = advance(sDial.option(form.Value, 'connect_timeout',
			_('Connect timeout'),
			_('Applied to every proxy node. A node that refuses connections is ' +
			  'dropped from its auto group immediately, but one that silently ' +
			  'discards traffic is not — without this, each attempt waits out ' +
			  'the kernel\'s retry schedule (around two minutes) with the app ' +
			  'hung behind it. Set 0 for no limit.')));
		oConnTimeout.placeholder = '5s';
		oConnTimeout['default']  = '5s';
		oConnTimeout.optional    = true;
		oConnTimeout.validate = function(section_id, value) {
			if (value == null || value === '' || value === '0')
				return true;
			// Go duration: one or more <number><unit> pairs, e.g. 5s, 1m30s.
			if (!/^(\d+(\.\d+)?(ns|us|ms|s|m|h))+$/.test(value))
				return _('Expected a duration such as "5s" or "1m30s", or 0 for no limit');
			return true;
		};

		// ── Latency testing ──────────────────────────────────────────────
		// Whole section is Advanced (same treadle-advanced wrapper-class
		// trick as Logging). The flag binds to `global` and feeds
		// build-config's experimental.clash_api emission; node probes
		// themselves run on an ephemeral sing-box instance started by the
		// test runner, so the running config stays lean.
		var sLatency = m.section(form.NamedSection, 'global', 'treadle', _('Latency testing'),
			_('Probe node round-trip time via sing-box\'s clash-compatible API. ' +
			  'The API binds 127.0.0.1 only — never exposed on the LAN.'));
		sLatency.addremove = false;

		var oClashApi = sLatency.option(form.Flag, 'clash_api_enabled',
			_('Enable latency testing'),
			_('Adds a loopback-only clash API listener to sing-box and a Test ' +
			  'button next to each node on the Nodes tab. Tests run on a ' +
			  'temporary second sing-box instance, so every known node is ' +
			  'testable without bloating the running config.'));
		oClashApi.rmempty = false;

		var oAutoTest = sLatency.option(form.Value, 'auto_test_hours',
			_('Auto-test interval (hours)'),
			_('Probe every node automatically each N hours, so the Latency ' +
			  'column stays fresh without clicking Test all. Runs from the ' +
			  'hourly maintenance tick after due subscription syncs, so newly ' +
			  'imported nodes are included. 0 disables.'));
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
		this._advSections = [sLatency, sLogging];

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
		formNode.appendChild(extraSection);

		return formNode;
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
