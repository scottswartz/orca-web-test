// The dock's helpers (Orca.UI/Docking, Orca.UI/Documentation)
(function () {
    // A web page shown in the app (an iframe, e.g. a device's manual) takes the pointer, so dragging a tool window,
    // a tab or a splitter over one would stop there. While a button is held down here, orca-dock.css lets the
    // pointer pass through iframes; a press inside an iframe never reaches this page, so the page itself still works
    const root = document.documentElement;
    const POINTER_DOWN = "orca-pointer-down";
    const release = () => root.classList.remove(POINTER_DOWN);

    document.addEventListener("pointerdown", () => root.classList.add(POINTER_DOWN), true);
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    // A button let go outside the window sends no pointerup
    document.addEventListener("pointermove", e => { if (e.buttons === 0) release(); }, true);
    window.addEventListener("blur", release);

    window.orcaDock = {
        // Scrolls the selected button of a row (class "on") into view, e.g. the Documentation window's open manuals
        revealSelected: row => row?.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "nearest" })
    };
})();
