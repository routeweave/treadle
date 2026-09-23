// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Single-page host view. Treadle is one menu entry; every former page is a
// panel mounted lazily into one cbi-map. This keeps the "Treadle" title above
// a single in-view tab bar (LuCI only auto-renders a sibling tab bar when a
// menu node has siblings — with one entry there are none).

'use strict';
'require view';
'require ui';
'require dom';
'require rpc';
'require uci';
'require session';
'require view.treadle.status as statusPanel';
'require view.treadle.nodes as nodesPanel';
'require view.treadle.routing as routingPanel';
'require view.treadle.settings as settingsPanel';
'require view.treadle.basic as basicPanel';

var TABS_ADVANCED = [
	{ id: 'status',   label: _('Status'),   panel: statusPanel },
	{ id: 'nodes',    label: _('Nodes'),    panel: nodesPanel },
	{ id: 'routing',  label: _('Routing'),  panel: routingPanel },
	{ id: 'settings', label: _('Settings'), panel: settingsPanel }
];

var TABS_BASIC = [
	{ id: 'status', label: _('Status'), panel: statusPanel },
	{ id: 'basic',  label: _('Basic'),  panel: basicPanel  }
];

var callSetMode = rpc.declare({
	object: 'luci.treadle',
	method: 'set_mode',
	params: ['mode'],
	expect: { '': {} }
});

// Count the staged UCI operations in the dict uci.changes() resolves to.
// Shape is { configName: [ [op, section, option, value?], … ] }; an empty
// dict means nothing is staged. Defensive against null/undefined arms.
function _changeCount(changes) {
	var n = 0;
	for (var k in changes) {
		if (changes.hasOwnProperty(k) && Array.isArray(changes[k]))
			n += changes[k].length;
	}
	return n;
}

return view.extend({
	// The host owns its own footers per active panel; suppress the framework one.
	handleSave:      null,
	handleSaveApply: null,
	handleReset:     null,

	load: function() {
		// The host owns the mode flag; each panel is mode-agnostic and just
		// renders. uci.load('treadle') round-trips through rpcd once, then
		// every panel that reads UCI hits the cache.
		return uci.load('treadle');
	},

	render: function() {
		this._mountGen = 0;
		// Tabs that staged UCI changes while active (dot in the tab bar) and
		// the staged-change count at the last tab activation — growth between
		// activations is attributed to the tab being left. Both reset on the
		// page reload an apply/revert performs.
		this._dirtyTabs = {};
		this._stagedBaseline = 0;
		this._mode = this._readMode();
		this._tabs = (this._mode === 'basic') ? TABS_BASIC : TABS_ADVANCED;
		this._topMenu = E('ul', { 'class': 'cbi-tabmenu' }, []);
		this._content = E('div', { 'class': 'treadle-tab-content' }, []);
		this._shell = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('Treadle') ]),
			this._topMenu,
			this._content,
			this._renderModeStyles()
		]);

		var self = this;
		return Promise.resolve(this._activate(this._initialRoute())).then(function() {
			return self._shell;
		});
	},

	_readMode: function() {
		// Anything but 'advanced' is the shipped default, as in build-config.
		var m = uci.get('treadle', 'global', 'mode');
		return (m === 'advanced') ? 'advanced' : 'basic';
	},

	// Tabs that don't exist in the current mode get folded onto the closest
	// equivalent so a stored session id from the other mode still lands on
	// something sensible after a Save & Apply reload.
	_redirectForMode: function(id) {
		if (this._mode === 'basic') {
			if (id === 'nodes' || id === 'routing' || id === 'settings')
				return 'basic';
		} else {
			if (id === 'basic')
				return 'status';
		}
		return id;
	},

	// Save & Apply reloads the page; restore the last active tab from LuCI's
	// session store — the same mechanism the stock form-tab pages use to
	// survive an apply. No URL hash is involved. `basic` exists only in Basic
	// mode and `nodes / routing / settings` only in Advanced, so a stored id
	// from the other mode is folded onto its closest equivalent.
	_initialRoute: function() {
		var group = session.getLocalData('treadle.activeTab') || this._tabs[0].id;
		return this._redirectForMode(group);
	},

	_buildMenu: function(items, activeId, onClick) {
		var self = this;
		var els = items.map(function(it) {
			return E('li', { 'class': it.id === activeId ? 'cbi-tab' : 'cbi-tab-disabled' }, [
				E('a', {
					'href': '#',
					'click': function(ev) { ev.preventDefault(); onClick(it.id); }
				}, [
					it.label,
					// Dot on tabs that staged changes — the color is
					// inherited from the tab label so it works on every
					// theme; the title carries the explanation.
					self._dirtyTabs[it.id] ? E('span', {
						'style': 'margin-left:0.3em;',
						'title': _('Changes from this tab are staged but not yet applied')
					}, [ '•' ]) : ''
				])
			]);
		});
		els.push(this._buildModeChip());
		return els;
	},

	// (Re)render the top tab bar from current state — called on every tab
	// activation and whenever the dirty-tab set changes.
	_renderMenu: function() {
		var self = this;
		dom.content(this._topMenu, this._buildMenu(this._tabs, this._activeGroup, function(id) {
			self._activate(id);
		}));
	},

	// Re-read the server-side staged-change count, attribute any growth
	// since the previous activation to the tab just left, and refresh the
	// dirty dots plus the footer note. Called after each panel mount and
	// after a footer Save; Save & Apply and Reset both end in a page
	// reload, so they need no refresh. Errors are swallowed — this is a
	// purely informational surface and must never break a tab switch.
	_refreshStagedState: function(leavingId) {
		var self = this;
		return uci.changes().then(function(changes) {
			var n = _changeCount(changes);
			if (leavingId && leavingId !== self._activeGroup && n > self._stagedBaseline)
				self._dirtyTabs[leavingId] = true;
			if (n === 0)
				self._dirtyTabs = {};  // applied or reverted out of band
			self._stagedBaseline = n;
			self._renderMenu();
			var note = document.getElementById('treadle-staged-note');
			if (note) {
				if (n > 0) {
					note.textContent = _('%d change(s) already staged — Save & Apply commits them all, including edits from other tabs.').format(n);
					note.style.display = '';
				} else {
					note.style.display = 'none';
				}
			}
		}).catch(function() {});
	},

	// Right-aligned mode toggle that lives inside the top tab bar (margin-left:
	// auto pushes it past the regular tabs). Text changes per mode: in Basic
	// it offers "Advanced mode →", in Advanced it offers "Basic mode →".
	// Switching back to Advanced is non-destructive (no confirm); switching to
	// Basic is also non-destructive — advanced config is kept on disk — but a
	// modal explains the new builder behaviour the first time the user flips
	// it from Advanced, so the change is never silent.
	_buildModeChip: function() {
		var self = this;
		var target = (this._mode === 'basic') ? 'advanced' : 'basic';
		var label  = (target === 'advanced')
			? _('Advanced mode →') : _('Basic mode →');
		return E('li', { 'class': 'treadle-mode-chip' }, [
			E('a', {
				'href':  '#',
				'title': (target === 'advanced')
					? _('Show every Treadle setting (Nodes, Routing, Settings tabs).')
					: _('Hide advanced settings. Your advanced configuration is kept on disk and returns when you switch back.'),
				'click': function(ev) {
					ev.preventDefault();
					self._handleModeSwitch(target);
				}
			}, [ label ])
		]);
	},

	_handleModeSwitch: function(target) {
		// The switch finishes with window.location.reload(), which drops any
		// staged-but-not-applied UCI changes on the floor. Warn the user
		// rather than silently throwing their edits away. uci.changes() is
		// an rpc.declare() in LuCI's JS API and returns a Promise resolving
		// to { config: [ [op, section, option, value?], … ] } — calling
		// Object.keys on the Promise itself silently yields [], so we have
		// to await the resolution before counting.
		var self = this;
		return uci.changes().then(function(changes) {
			return self._showModeSwitchModal(target, _changeCount(changes));
		});
	},

	_showModeSwitchModal: function(target, dirty) {
		if (target === 'advanced' && !dirty) {
			return this._applyModeSwitch(target);
		}

		var title, body, confirm;
		if (target === 'basic') {
			title = _('Switch to Basic mode?');
			body  = _('Basic mode hides Nodes, Routing and Settings and builds the running ' +
				'sing-box config from the Basic tab only. Your advanced configuration ' +
				'is kept on disk and will be active again when you switch back to Advanced.');
			confirm = _('Switch to Basic');
		} else {
			title = _('Switch to Advanced mode?');
			body  = _('Advanced mode exposes Nodes, Routing and Settings.');
			confirm = _('Switch to Advanced');
		}

		var children = [ E('p', {}, [ body ]) ];
		if (dirty) {
			children.push(E('p', { 'class': 'alert-message warning' }, [
				_('You have unsaved changes on this page. Switching mode reloads ' +
				  'the page and discards them.')
			]));
		}
		children.push(E('div', { 'class': 'right' }, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, [ _('Cancel') ]),
			' ',
			E('button', {
				'class': 'btn cbi-button-apply',
				'click': ui.createHandlerFn(this, '_applyModeSwitch', target)
			}, [ confirm ])
		]));
		ui.showModal(title, children);
	},

	_applyModeSwitch: function(target) {
		ui.hideModal();
		// ui.changes.revert() is fire-and-forget: it kicks off a UCI revert
		// request, shows the "Changes have been reverted" toast, and reloads
		// the page itself via window.location = … after L.env.apply_display
		// seconds. It returns undefined, so chaining .then() on it either
		// throws or races with the reload — which is why the old order
		// (revert → set_mode) silently dropped the mode write and bounced
		// the user back into Advanced.
		//
		// Commit the mode through rpcd first. Then, only if staged changes
		// exist, hand off to ui.changes.revert() so the new mode's tab
		// doesn't inherit the "apply pending changes" banner for sections
		// it may not expose. Otherwise just reload — that keeps a misleading
		// "Changes have been reverted" toast from appearing on a clean switch.
		return callSetMode(target).then(function() {
			// Drop the stored tab id so the new mode lands on its first tab
			// cleanly instead of being redirected through the cross-mode map.
			session.setLocalData('treadle.activeTab', '');
			return uci.changes();
		}).then(function(changes) {
			if (_changeCount(changes) > 0) {
				ui.changes.revert();
			} else {
				window.location.reload();
			}
		}).catch(function(err) {
			ui.addNotification(null, E('p', _('Mode switch failed: ') +
				((err && err.message) ? err.message : err)), 'error');
		});
	},

	_renderModeStyles: function() {
		// Theme variables with literal fallbacks (same pattern as
		// lib/badges.js) — hardcoded #666/#000 disappeared against the
		// dark Material theme's background.
		return E('style', {}, [
			'.cbi-tabmenu .treadle-mode-chip{margin-left:auto;border:none;background:none}' +
			'.cbi-tabmenu .treadle-mode-chip a{padding:0.4em 0.6em;' +
				'color:var(--text-color-medium, #666);' +
				'font-size:0.85em;text-decoration:none}' +
			'.cbi-tabmenu .treadle-mode-chip a:hover{color:var(--text-color-high, #000)}'
		]);
	},

	_buildFooter: function(panel) {
		var hasApply = (typeof panel.handleSaveApply === 'function');
		var hasSave  = (typeof panel.handleSave === 'function');
		var hasReset = (typeof panel.handleReset === 'function');
		if (!hasApply && !hasSave && !hasReset)
			return null;

		var host = this;
		return E('div', { 'class': 'cbi-page-actions' }, [
			// Populated by _refreshStagedState when staged changes exist:
			// all panels share one UCI config, so Save & Apply commits
			// more than what is visible on the current tab — say so right
			// next to the button that does it.
			E('span', {
				'id': 'treadle-staged-note',
				'style': 'display:none; margin-right:0.8em; font-size:0.9em; opacity:0.7;'
			}),
			hasApply ? E('button', {
				'class': 'btn cbi-button cbi-button-apply',
				'click': ui.createHandlerFn(panel, 'handleSaveApply')
			}, [ _('Save & Apply') ]) : '',
			hasSave ? E('button', {
				'class': 'btn cbi-button cbi-button-save',
				// Save stages without applying — refresh the staged note
				// so the new count shows up immediately.
				'click': ui.createHandlerFn(panel, function(ev) {
					return Promise.resolve(this.handleSave(ev)).then(function() {
						return host._refreshStagedState();
					});
				})
			}, [ _('Save') ]) : '',
			hasReset ? E('button', {
				'class': 'btn cbi-button cbi-button-reset',
				'click': ui.createHandlerFn(panel, 'handleReset')
			}, [ _('Reset') ]) : ''
		]);
	},

	// Re-mount the currently active panel (used by panels after an async
	// action — e.g. a subscription sync — changes UCI out of band).
	remountActive: function() {
		return this._activate(this._activeGroup);
	},

	_activate: function(groupId) {
		var self = this;
		var gen = ++this._mountGen;
		// The tab being left — staged-change growth since its activation is
		// attributed to it by _refreshStagedState below.
		var leaving = this._activeGroup;

		if (this._panel && typeof this._panel._teardown === 'function') {
			// Swallowed by design: _teardown's job is to clear timers
			// and abort polls. A throw here cannot meaningfully block
			// the mode/tab switch the user just initiated — but it
			// must not crash _activate either, leaving the host in
			// an inconsistent state with the new panel half-mounted.
			try { this._panel._teardown(); } catch (e) {}
		}
		this._panel = null;

		var group = this._tabs.filter(function(t) { return t.id === groupId; })[0] || this._tabs[0];
		groupId = group.id;

		this._activeGroup = groupId;
		session.setLocalData('treadle.activeTab', groupId);

		this._renderMenu();

		dom.content(this._content, []);
		var mountTarget = this._content;

		if (this._footer && this._footer.parentNode)
			this._footer.parentNode.removeChild(this._footer);
		this._footer = null;

		// LuCI's require() returns an already-constructed singleton, not a
		// class — use the panel instance directly (do not `new` it). Reuse
		// across activations is safe: switches are sequential and each
		// render() rebuilds the panel's DOM and state.
		var panel = group.panel;
		panel._treadleHost = this;
		this._panel = panel;

		dom.content(mountTarget, E('div', { 'class': 'spinning' }, [ _('Loading…') ]));

		return Promise.resolve().then(function() {
			return (typeof panel.load === 'function') ? panel.load() : null;
		}).then(function(data) {
			if (gen !== self._mountGen) return;
			return Promise.resolve(panel.render(data)).then(function(node) {
				if (gen !== self._mountGen) return;
				dom.content(mountTarget, node);
				var footer = self._buildFooter(panel);
				if (footer) {
					self._footer = footer;
					self._shell.appendChild(footer);
				}
				return self._refreshStagedState(leaving);
			});
		}).catch(function(err) {
			if (gen !== self._mountGen) return;
			dom.content(mountTarget, E('div', { 'class': 'alert-message warning' }, [
				_('Failed to load this tab: ') + (err && err.message ? err.message : err)
			]));
		});
	}
});
