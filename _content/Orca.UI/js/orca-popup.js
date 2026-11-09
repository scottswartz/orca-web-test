// Closes a popup (menu, dropdown) on a click outside it or Esc, for PopupCloser.cs. Listens only while the popup is
// open: start() when it opens, stop() when it closes. Capture phase and pointerdown, so the click still reaches what
// was clicked (e.g. a tree row is selected and the menu closes in one click).
window.orcaPopup = {
    listeners: new Map(),
    nextId: 1,

    start: function (popup, dotNetRef) {
        var id = window.orcaPopup.nextId++;

        var close = function () {
            window.orcaPopup.stop(id);
            dotNetRef.invokeMethodAsync('ClosePopup');
        };
        var onPointerDown = function (event) {
            if (popup && !popup.contains(event.target)) {
                close();
            }
        };
        var onKeyDown = function (event) {
            if (event.key === 'Escape') {
                close();
            }
        };

        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.orcaPopup.listeners.set(id, { onPointerDown: onPointerDown, onKeyDown: onKeyDown });
        return id;
    },

    stop: function (id) {
        var listener = window.orcaPopup.listeners.get(id);
        if (!listener) {
            return;
        }
        document.removeEventListener('pointerdown', listener.onPointerDown, true);
        document.removeEventListener('keydown', listener.onKeyDown, true);
        window.orcaPopup.listeners.delete(id);
    }
};
