// Multi-cell paste for the CalibrationForm grid.
// Blazor's @onpaste can't see the pasted text, so this listens on the grid's host element instead. When the
// clipboard holds more than one cell (a tab or line break), it stops the normal paste and hands the row,
// column and raw text to the .NET component. A single value pastes normally into the cell.
// Each grid cell's input sits in a <div data-row="n" data-col="0|1">.

export function attachPaste(host, dotnet) {
    if (!host || host.__orcaPaste) return;
    host.__orcaPaste = true;

    host.addEventListener('paste', (e) => {
        const cell = e.target.closest('[data-row][data-col]');
        if (!cell || !host.contains(cell)) return;

        const text = e.clipboardData ? e.clipboardData.getData('text') : '';
        if (!/[\t\n]/.test(text.replace(/[\r\n]+$/, ''))) return;

        e.preventDefault();
        e.stopPropagation();
        dotnet.invokeMethodAsync('PasteCells', Number(cell.dataset.row), Number(cell.dataset.col), text);
    }, true); // capture: run before the grid or the input handles the paste
}
