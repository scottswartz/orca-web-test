(function () {
    // Plain tables marked orca-tab-adds-row (e.g. dialog value tables) work like the grids
    var CELL_SELECTOR = '.orca-cell-input:not([disabled]), .orca-cell-select:not([disabled]), table.orca-tab-adds-row input:not([disabled])';

    document.addEventListener('keydown', function (e) {
        var isEnter = e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey;
        if (e.key !== 'Tab' && !isEnter) {
            return;
        }

        var target = e.target;
        if (!target || !target.matches || !target.matches(CELL_SELECTOR)) {
            return;
        }

        var grid = target.closest('.e-grid, table.orca-tab-adds-row');
        if (!grid) {
            return;
        }

        var cells = Array.prototype.slice.call(grid.querySelectorAll(CELL_SELECTOR));
        var index = cells.indexOf(target);
        if (index === -1) {
            return;
        }

        // Enter only adds a row, from the last cell of an orca-tab-adds-row table or grid; elsewhere it's left alone
        if (isEnter && (!grid.classList.contains('orca-tab-adds-row') || index !== cells.length - 1)) {
            return;
        }

        var nextIndex = e.shiftKey ? index - 1 : index + 1;
        if (nextIndex === cells.length && grid.classList.contains('orca-tab-adds-row')) {
            var addButton = findAddButton(grid);
            if (addButton && !addButton.disabled) {
                e.preventDefault();
                e.stopPropagation();
                addRowAndFocus(grid, target, addButton, cells.length);
                return;
            }
        }
        if (nextIndex < 0 || nextIndex >= cells.length) {
            // Let Tab leave the grid normally at the first/last cell.
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        focusCell(cells[nextIndex]);
    }, true);

    function focusCell(cell) {
        cell.focus();
        if (typeof cell.select === 'function') {
            cell.select();
        }
    }

    // The nearest [data-orca-add-row] button around the grid (the grid's own toolbar Add)
    function findAddButton(grid) {
        for (var el = grid.parentElement; el; el = el.parentElement) {
            var button = el.querySelector('[data-orca-add-row]');
            if (button) {
                return button;
            }
        }
        return null;
    }

    // Commit the cell first (Tab no longer blurs it), add the row, then focus its first cell once rendered
    function addRowAndFocus(grid, target, addButton, oldCount) {
        target.dispatchEvent(new Event('change', { bubbles: true }));
        addButton.click();

        var deadline = Date.now() + 2000;
        (function waitForRow() {
            var cells = grid.querySelectorAll(CELL_SELECTOR);
            if (cells.length > oldCount) {
                focusCell(cells[oldCount]);
            } else if (Date.now() < deadline) {
                requestAnimationFrame(waitForRow);
            }
        })();
    }
})();

window.orcaGrid = {
    // Scrolls a grid's row into view once the grid has redrawn with rowCount rows (e.g. after adding signals)
    revealRow: function (gridSelector, rowIndex, rowCount) {
        var deadline = Date.now() + 2000;
        (function waitForRow() {
            var grid = document.querySelector(gridSelector);
            var rows = grid ? grid.querySelectorAll('tr.e-row') : [];
            if (rows.length >= rowCount && rows[rowIndex]) {
                rows[rowIndex].scrollIntoView({ block: 'nearest', inline: 'nearest' });
            } else if (Date.now() < deadline) {
                requestAnimationFrame(waitForRow);
            }
        })();
    }
};
