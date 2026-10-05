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
'require uci';
'require session';
'require view.treadle.status as statusPanel';
'require view.treadle.nodes as nodesPanel';
'require view.treadle.routing as routingPanel';
'require view.treadle.settings as settingsPanel';

var TABS = [
	{ id: 'status',   label: _('Status'),   panel: statusPanel },
	{ id: 'nodes',    label: _('Nodes'),    panel: nodesPanel },
	{ id: 'routing',  label: _('Routing'),  panel: routingPanel },
	{ id: 'settings', label: _('Settings'), panel: settingsPanel }
];

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
		// uci.load('treadle') round-trips through rpcd once, then every
		// panel that reads UCI hits the cache.
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
		this._tabs = TABS;
		this._topMenu = E('ul', { 'class': 'cbi-tabmenu' }, []);
		this._content = E('div', { 'class': 'treadle-tab-content' }, []);
		this._shell = E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('Treadle') ]),
			this._topMenu,
			this._content
		]);

		var self = this;
		return Promise.resolve(this._activate(this._initialRoute())).then(function() {
			return self._shell;
		});
	},

	// Save & Apply reloads the page; restore the last active tab from LuCI's
	// session store — the same mechanism the stock form-tab pages use to
	// survive an apply. No URL hash is involved. An unknown stored id (the
	// removed Basic tab) falls back to the first tab in _activate.
	_initialRoute: function() {
		return session.getLocalData('treadle.activeTab') || this._tabs[0].id;
	},

	_buildMenu: function(items, activeId, onClick) {
		var self = this;
		return items.map(function(it) {
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
			// the tab switch the user just initiated — but it
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
