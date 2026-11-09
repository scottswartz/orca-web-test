window.orcaTree = {
    // Scrolls the selected row into view after navigating from the validation grid.
    // focusRow is false when the cursor goes to a field instead, so the row doesn't take it back.
    revealSelected: function (tree, focusRow) {
        var row = tree && tree.querySelector('.orca-tree-row.selected');
        if (!row) {
            return;
        }

        row.scrollIntoView({ block: 'center', inline: 'nearest' });
        if (focusRow !== false) {
            row.focus({ preventScroll: true });
        }
    }
};
