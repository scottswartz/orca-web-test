(function () {
    var CELL_SELECTOR = '.orca-cell-input:not([disabled]), .orca-cell-select:not([disabled])';

    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Tab') {
            return;
        }

        var target = e.target;
        if (!target || !target.matches || !target.matches(CELL_SELECTOR)) {
            return;
        }

        var grid = target.closest('.e-grid');
        if (!grid) {
            return;
        }

        var cells = Array.prototype.slice.call(grid.querySelectorAll(CELL_SELECTOR));
        var index = cells.indexOf(target);
        if (index === -1) {
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
