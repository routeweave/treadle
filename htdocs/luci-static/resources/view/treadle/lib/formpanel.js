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
	},

	// Move a GridSection's Delete from every row into its edit dialog, next
	// to Dismiss and Save: rows keep only the buttons used every day, and a
	// delete is no longer one stray click away. It stages the removal like
	// the row button did; Save & Apply commits it.
	deleteInModal: function(s) {
		var render = s.renderRowActions;
		s.renderRowActions = function(section_id) {
			var td = render.apply(this, arguments);
			var rm = td && td.querySelector && td.querySelector('.cbi-button-remove');
			if (rm) rm.parentNode.removeChild(rm);
			return td;
		};
		var openModal = s.renderMoreOptionsModal;
		s.renderMoreOptionsModal = function(section_id) {
			var section = this;
			return Promise.resolve(openModal.apply(this, arguments)).then(function(r) {
				var row = document.querySelector('#modal_overlay .modal .button-row');
				if (row && !row.querySelector('.treadle-delete'))
					row.insertBefore(E('button', {
						'class': 'btn cbi-button cbi-button-remove treadle-delete',
						'style': 'margin-right:auto;',
						'click': function() {
							ui.hideModal();
							return section.handleRemove(section_id);
						}
					}, [ _('Delete') ]), row.firstChild);
				return r;
			});
		};
	}
});
