// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Per-row subscription Sync button handler shared by the Nodes and Basic
// panels — both render the same Sync column over the same UCI sections,
// and the two hand-rolled copies had already drifted (one restored the
// button's spinner class in `finally`, the other did not).

'use strict';
'require baseclass';
'require rpc';
'require ui';
'require uci';

var callSyncSubscription = rpc.declare({
	object: 'luci.treadle',
	method: 'sync_subscription',
	params: ['id'],
	expect: { '': {} }
});

var callReloadIfChanged = rpc.declare({
	object: 'luci.treadle',
	method: 'reload_if_changed',
	expect: { '': {} }
});

// Busy-state restyle for the Sync button: hide the label and center the
// wheel instead of the themes' default (label kept, button widened by
// `.spinning`'s padding-left:32px). The label is hidden with transparent
// color — not by emptying it — and the button's natural width is pinned
// with border-box sizing, so the size cannot change while spinning. The
// ::before override unifies both supported themes' spinner geometry
// (bootstrap: 20px mask box at left:6px; material: 32px background box,
// background-size 16px centered) into one 20px box centered both ways.
var SPIN_CSS =
	'.treadle-sync-spin.spinning {' +
	' box-sizing: border-box; overflow: hidden; color: transparent !important; }' +
	'.treadle-sync-spin.spinning::before {' +
	' left: calc(50% - 10px); top: calc(50% - 10px);' +
	' bottom: auto; width: 20px; height: 20px; }';

function ensureSpinStyle() {
	if (!document.getElementById('treadle-sync-spin-style'))
		document.head.appendChild(
			E('style', { 'id': 'treadle-sync-spin-style' }, [ SPIN_CSS ]));
}

return baseclass.extend({
	// Sync the subscription, reload sing-box only if the active outbound
	// set changed, then remount the panel from re-read UCI. The .spinning
	// class itself is owned by form.Button's ui.createHandlerFn wrapper
	// (added before this handler runs, removed when the returned promise
	// settles); this handler only adds the scoping class for the centered
	// variant above and pins the width. `panel` is the calling panel
	// instance (its _treadleHost is set by main.js when the panel mounts).
	handleSync: function(panel, ev, section_id) {
		var btn = ev.currentTarget;
		ensureSpinStyle();
		// The wrapper's .spinning (padding-left 32px) is already applied —
		// lift it for one synchronous layout pass to measure the button's
		// natural width, then pin that width for the spinning state.
		btn.classList.remove('spinning');
		var w = btn.offsetWidth;
		btn.classList.add('spinning');
		btn.classList.add('treadle-sync-spin');
		btn.style.width = w + 'px';
		return callSyncSubscription(section_id).then(function(res) {
			var ok = res && res.status === 'ok';
			ui.addNotification(null, E('p',
				ok ? _('Synced: %d nodes.').format(res.node_count || 0)
				   : _('Sync failed.')),
				ok ? 'info' : 'warning');
			if (!ok)
				return;
			return callReloadIfChanged().then(function(r) {
				if (r && r.reloaded)
					ui.addNotification(null,
						E('p', _('Active node changed — sing-box reloaded.')), 'info');
				// Close the edit modal first if the sync was triggered
				// from inside it — remountActive() would orphan it.
				ui.hideModal();
				// The RPC committed node_count / status / last_sync to UCI
				// on disk; reload from disk so the grid reflects them
				// without staging phantom changes the way uci.set would.
				uci.unload('treadle');
				return uci.load('treadle').then(function() {
					return panel._treadleHost.remountActive();
				});
			});
		}).catch(function() {
			ui.addNotification(null, E('p', _('Sync failed.')), 'error');
		}).finally(function() {
			// A failed or no-op sync keeps the same DOM (no remount) —
			// return the button to its label state.
			btn.classList.remove('treadle-sync-spin');
			btn.style.width = '';
		});
	}
});
