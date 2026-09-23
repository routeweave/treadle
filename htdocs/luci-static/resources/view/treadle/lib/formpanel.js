// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 RouteWeave

// Shared Save / Save & Apply / Reset logic for the form.Map-backed panels.
// LuCI's require() hands back a singleton instance, not an extendable class,
// so the panels can't inherit from a base — instead each panel keeps three
// one-line handlers that delegate here, passing itself as `panel` (every
// panel stores its form.Map on panel.map). Same pattern as view.treadle.lib.ordersave.

'use strict';
'require baseclass';
'require ui';

return baseclass.extend({
	save: function(panel) {
		return panel.map.save();
	},

	saveApply: function(panel) {
		return panel.map.save().then(function() {
			// Plain apply — the rollback-protected variant's ceremony is not
			// needed here: a Treadle settings change cannot sever the admin's
			// LuCI session, which reaches the router's own LAN IP directly.
			return ui.changes.apply();
		});
	},

	// Reset for a plain form.Map panel — revert the widgets to saved state.
	reset: function(panel) {
		return panel.map.reset();
	},

	// Reset for a GridSection panel. A grid edit is flushed to the backend
	// change-staging the moment its modal is saved (the modal's Save calls
	// m.save() → uci.save()), so by the time the panel-level Reset runs there
	// are no un-saved widget edits left to drop — uci.unload + remount would
	// silently do nothing. Only the global revert clears staged changes, so
	// delegate to it. Treadle only ever edits the `treadle` config, so a global
	// revert and a per-panel reset clear the same set.
	resetGrid: function() {
		return ui.changes.revert();
	}
});
