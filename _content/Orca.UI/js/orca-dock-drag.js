// From Blazor Blueprint 4.1.0 js/dock.js (Apache 2.0: Orca.UI/Docking/LICENSE.txt, NOTICE.txt), changed for Orca:
// see the "Orca:" comments. Loaded by OrcaDock and OrcaDockTabGroup instead of the package's copy
//
// Docking interactions for BbDock.
//
// Handles three pointer-driven gestures:
//   1. Dragging a panel tab to re-dock it (as a tab or a split), to a dock edge, or out to a
//      floating window. Draws a live drop indicator and reports the resolved drop to .NET.
//   2. Dragging a floating window by its tab strip to reposition it.
//   3. Dragging a floating window's resize grip to resize it.
//
// .NET owns the layout model; this module only computes drop targets and reports results.

const docks = new Map();
const DRAG_THRESHOLD = 4;
// Theme design tokens (full color values, oklch) so the overlays match both light and dark themes.
// Orca: a lighter preview, like Visual Studio's (was 25% and a 2px border)
const ACCENT_BG = "color-mix(in oklab, var(--primary) 16%, transparent)";
const ACCENT_BORDER = "1px solid var(--primary)";
const ACCENT_SOLID = "var(--primary)";

export function initializeDock(dockId, rootEl, dotNetRef) {
    if (!dockId || !rootEl || !dotNetRef) {
        return;
    }
    docks.set(dockId, { rootEl, dotNetRef, cancelSession: null });
}

export function disposeDock(dockId) {
    const dock = docks.get(dockId);
    if (dock && dock.cancelSession) {
        // Abort any in-flight drag so ghost/indicator elements and document-level
        // listeners are not orphaned when the component is disposed mid-gesture.
        dock.cancelSession();
    }
    docks.delete(dockId);
}

// ---------------------------------------------------------------- tab strip overflow

// One entry per observed tab strip, keyed by the tab group's id.
const tabOverflowObservers = new Map();

// Sets up overflow tracking for a tab strip. Whenever the strip resizes, the set of tabs
// that no longer fit is recomputed and reported to .NET so it can hide them and surface an
// overflow ("…") dropdown instead of a scrollbar.
export function initTabOverflow(groupId, stripEl, dotNetRef) {
    if (!groupId || !stripEl || !dotNetRef) {
        return;
    }

    disposeTabOverflow(groupId);

    const ro = new ResizeObserver(() => reportTabOverflow(groupId));
    ro.observe(stripEl);

    // The tabs are divs, so keys the tablist handles (roving focus + activation, done in
    // .NET) would otherwise also scroll the page. Buttons inside a tab (e.g. close) are
    // left alone so Space/Enter still click them.
    const onKeyDown = (e) => {
        if (!e.target.closest || !e.target.closest("[data-dock-tab]") || e.target.closest("button")) {
            return;
        }
        if (e.key === " " || e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
            e.preventDefault();
        }
    };
    stripEl.addEventListener("keydown", onKeyDown);

    tabOverflowObservers.set(groupId, { observer: ro, stripEl, dotNetRef, onKeyDown });
    reportTabOverflow(groupId);
}

// Recomputes overflow for an already-observed strip (e.g. after tabs are added or removed).
export function remeasureTabOverflow(groupId) {
    reportTabOverflow(groupId);
}

export function disposeTabOverflow(groupId) {
    const entry = tabOverflowObservers.get(groupId);
    if (entry) {
        entry.observer.disconnect();
        entry.stripEl.removeEventListener("keydown", entry.onKeyDown);
        tabOverflowObservers.delete(groupId);
    }
}

function reportTabOverflow(groupId) {
    const entry = tabOverflowObservers.get(groupId);
    if (!entry) {
        return;
    }

    const ids = computeOverflowIds(entry.stripEl);
    entry.dotNetRef.invokeMethodAsync("OnTabOverflowChanged", ids).catch(() => { });
}

// Returns the ids of tabs that do not fully fit within the strip's visible width, in order.
// Tabs may currently be hidden (display:none) from a previous pass, so each is temporarily
// forced visible for measurement and then restored — the natural widths stay stable, which
// prevents the hide/show feedback loop a naive measurement would cause.
function computeOverflowIds(stripEl) {
    if (!stripEl) {
        return [];
    }

    const tabs = Array.from(stripEl.querySelectorAll("[data-dock-tab]"));
    if (tabs.length === 0) {
        return [];
    }

    const saved = tabs.map((t) => t.style.display);
    for (const t of tabs) {
        t.style.display = "flex";
    }

    const available = stripEl.clientWidth;
    const overflow = [];
    let used = 0;
    for (const t of tabs) {
        used += t.offsetWidth;
        // A 1px tolerance absorbs sub-pixel rounding so a tab that exactly fits is not hidden.
        if (used > available + 1) {
            overflow.push(t.getAttribute("data-dock-tab"));
        }
    }

    for (let i = 0; i < tabs.length; i++) {
        tabs[i].style.display = saved[i];
    }

    return overflow;
}

// ---------------------------------------------------------------- shared pointer session

// Runs a document-level pointer session for a single pointer. Events from other pointers
// (a second finger, a touch during a mouse drag) are ignored entirely so they can neither
// commit nor tear down the session. pointerup commits via handlers.up; pointercancel
// aborts via handlers.cancel (no commit). The session registers a cancel handle on the
// dock so disposeDock can abort an in-flight gesture.
function attachSession(dock, pointerId, handlers) {
    const onMove = (e) => {
        if (e.pointerId !== pointerId) {
            return;
        }
        handlers.move(e);
    };
    const onUp = (e) => {
        if (e.pointerId !== pointerId) {
            return;
        }
        detach();
        handlers.up(e);
    };
    const onCancel = (e) => {
        if (e.pointerId !== pointerId) {
            return;
        }
        cancel();
    };
    const detach = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onCancel);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        if (dock && dock.cancelSession === cancel) {
            dock.cancelSession = null;
        }
    };
    const cancel = () => {
        detach();
        if (handlers.cancel) {
            handlers.cancel();
        }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.body.style.userSelect = "none";

    if (dock) {
        dock.cancelSession = cancel;
    }
}

// ---------------------------------------------------------------- tab drag → docking

export function startTabDrag(dockId, title, clientX, clientY, pointerId) {
    const dock = docks.get(dockId);
    if (!dock) {
        return;
    }

    const state = {
        dock,
        title: title || "Panel",
        pointerId,
        startX: clientX,
        startY: clientY,
        active: false,
        ghost: null,
        indicator: null,
        target: null,
        // Orca: the window it's in, to take it out of the dock at its size (see undock)
        sourceGroup: document.elementFromPoint(clientX, clientY)?.closest("[data-dock-group]") || null
    };

    attachSession(dock, pointerId, {
        move: (e) => onTabMove(state, e),
        up: (e) => onTabUp(state, e),
        cancel: () => abortTabDrag(state)
    });
}

// A cancelled gesture (pointercancel, or the dock being disposed mid-drag) aborts the
// drag: the ghost and drop indicator are removed and no drop is reported to .NET.
function abortTabDrag(state) {
    removeEl(state.ghost);
    removeEl(state.indicator);
    removeGuides(state);
    state.ghost = null;
    state.indicator = null;
    // Orca: a window already out of the dock stays floating where it is, as in Visual Studio
    if (state.winEl) {
        state.winEl.style.pointerEvents = "";
    }
}

function onTabMove(state, e) {
    if (!state.active) {
        const dx = e.clientX - state.startX;
        const dy = e.clientY - state.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
            return;
        }
        state.active = true;
        document.body.style.cursor = "default";
        // Orca: was a label following the pointer; now the window itself (falls back to the label)
        undock(state, e);
    }

    if (state.windowId) {
        moveUndocked(state, e);
    } else {
        moveGhost(state.ghost, e.clientX, e.clientY);
    }
    // Orca: the guides first, since the target is the guide under the pointer
    placeGuides(state, e.clientX, e.clientY);
    state.target = computeTarget(state, e.clientX, e.clientY);
    highlightGuide(state, state.target);
    drawIndicator(state, state.target);
}

// Orca: like Visual Studio, a docked window being dragged comes out of the dock at once, at its size, and the drag
// moves the window itself; the space it left closes up, so it never offers to dock into itself. .NET floats it
// (OnTabDragUndock) and says which window it is; until then, and for a window that can't float, a label follows
function undock(state, e) {
    const r = state.dock.rootEl.getBoundingClientRect();
    const g = state.sourceGroup ? state.sourceGroup.getBoundingClientRect() : null;
    const width = g ? Math.min(g.width, r.width * 0.8) : 360;
    const height = g ? Math.min(g.height, r.height * 0.8) : 260;
    // Where it was grabbed, kept under the pointer: along the title bar, near its top
    state.offsetX = g ? Math.min(Math.max(state.startX - g.left, 0), width - 24) : 24;
    state.offsetY = g ? Math.min(Math.max(state.startY - g.top, 0), 14) : 12;

    state.undocking = state.dock.dotNetRef
        .invokeMethodAsync("OnTabDragUndock", e.clientX - r.left - state.offsetX, e.clientY - r.top - state.offsetY, width, height)
        .then(id => { state.windowId = id || null; })
        .catch(() => { state.windowId = null; })
        .then(() => {
            if (!state.windowId && state.active && !state.ghost) {
                state.ghost = createGhost(state.title);
            }
        });
}

function moveUndocked(state, e) {
    const root = state.dock.rootEl;
    // Drawn by .NET a moment after OnTabDragUndock
    if (!state.winEl || !state.winEl.isConnected) {
        state.winEl = root.querySelector(`[data-dock-window="${state.windowId}"]`);
        if (!state.winEl) {
            return;
        }
        // So the guides and targets see what's under it
        state.winEl.style.pointerEvents = "none";
    }

    const r = root.getBoundingClientRect();
    state.winEl.style.left = `${Math.max(0, e.clientX - r.left - state.offsetX)}px`;
    state.winEl.style.top = `${Math.max(0, e.clientY - r.top - state.offsetY)}px`;
}

function onTabUp(state, e) {
    removeEl(state.ghost);
    removeEl(state.indicator);
    removeGuides(state);
    state.ghost = null;
    state.indicator = null;

    if (!state.active) {
        // No movement past the threshold — treat as a click, not a drag.
        return;
    }

    // Orca: out of the dock (or about to be): drop the window like a floating one
    if (state.undocking) {
        state.undocking.then(() => {
            if (state.windowId) {
                const r = state.dock.rootEl.getBoundingClientRect();
                dropWindow(state.dock, state.windowId, state.winEl, state.target,
                    e.clientX - r.left - state.offsetX, e.clientY - r.top - state.offsetY);
            } else {
                dropTab(state, e);
            }
        });
        return;
    }

    dropTab(state, e);
}

// Orca: the original drop, for a window that couldn't come out of the dock
function dropTab(state, e) {
    const t = state.target || { type: "none" };
    let floatX = 0;
    let floatY = 0;

    if (t.type === "float") {
        const r = state.dock.rootEl.getBoundingClientRect();
        floatX = e.clientX - r.left - 24;
        floatY = e.clientY - r.top - 12;
    }

    state.dock.dotNetRef
        .invokeMethodAsync("OnTabDropped", t.type, t.groupId || null, t.zone || "center", floatX, floatY, typeof t.index === "number" ? t.index : -1)
        .catch(() => { });
}

/**
 * Whether the dock lays its panels out right to left. The dock's model is ordered — a zone of
 * "left" means "before this panel" — and a flex row reverses under dir="rtl", so the pointer's
 * horizontal decisions are mirrored to keep the model in step with what is on screen.
 */
function isRtl(dock) {
    return getComputedStyle(dock.rootEl).direction === "rtl";
}

// Orca: was invisible zones (a band along the dock's edges, the sides and middle of the window under the pointer).
// Now Visual Studio's: the guide under the pointer, else a tab strip to reorder, else it floats
function computeTarget(state, x, y) {
    const dock = state.dock;
    const r = dock.rootEl.getBoundingClientRect();
    const rtl = isRtl(dock);

    if (x < r.left || x > r.right || y < r.top || y > r.bottom) {
        return { type: "float" };
    }

    const guide = guideAt(state, x, y, rtl);
    if (guide) {
        return guide;
    }

    // Hovering a tab strip reorders within (or into) that group without changing the layout.
    const stripEl = findClosestAt(dock, x, y, "[data-dock-tabstrip]");
    if (stripEl) {
        return {
            type: "reorder",
            groupId: stripEl.getAttribute("data-dock-tabstrip"),
            index: computeInsertIndex(stripEl, x, rtl)
        };
    }

    return { type: "float" };
}

// ---------------------------------------------------------------- Orca: docking guides

// Drawn like Visual Studio's, while a window is dragged:
// - a guide at the middle of each edge of the dock (docks against the whole dock): a narrow window and an arrow
//   pointing at that edge, on a small plate
// - a compass over the window or page under the pointer: five tiles on one plus-shaped plate. The centre adds a tab,
//   the arms dock on that side. Over the page the centre is greyed (one page at a time); over another floating
//   window there are no arms (it holds one group)
// Each tile is a small window with a blue title bar; a dashed line shows where an arm would split it
const TILE = 24;
const CELL = 28;
const PAD = 3;
const PLATE = 3 * CELL + 2 * PAD;
const EDGE_INSET = 6;
const SIDES = ["left", "right", "top", "bottom"];
const SVG_NS = "http://www.w3.org/2000/svg";
const PLATE_FILL = "color-mix(in oklab, var(--foreground) 6%, var(--background))";
const TILE_HOVER = "color-mix(in oklab, var(--primary) 18%, var(--background))";

// The plate's outline: a plus, or (centre only) the middle square
function platePath(plus) {
    const a = CELL;
    const b = 2 * CELL + 2 * PAD;
    return plus
        ? `M${a},0.5H${b}V${a}H${PLATE - 0.5}V${b}H${b}V${PLATE - 0.5}H${a}V${b}H0.5V${a}H${a}Z`
        : `M${a},${a}H${b}V${b}H${a}Z`;
}

function createPlate(size, path) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.style.cssText = "position:fixed;z-index:10001;pointer-events:none;display:none;overflow:visible;" +
        "filter:drop-shadow(0 2px 4px rgba(0,0,0,.18));";
    const shape = document.createElementNS(SVG_NS, "path");
    shape.setAttribute("d", path);
    shape.style.cssText = `fill:${PLATE_FILL};stroke:var(--border);stroke-width:1;`;
    svg.appendChild(shape);
    document.body.appendChild(svg);
    return svg;
}

// The icon inside a tile (20 x 20): a window with a blue title bar, and what docking there does to it
function tileIcon(kind) {
    const line = "stroke:var(--muted-foreground);stroke-width:1;fill:none;";
    const win = (x, y, w, h) =>
        `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="1" style="fill:var(--background);${line}"/>` +
        `<rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="2.5" style="fill:var(--primary);"/>`;
    const shade = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" style="fill:var(--primary);opacity:.3;"/>`;
    const dashes = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="${line}stroke-dasharray:1.5 1.5;"/>`;
    const arrow = points => `<polygon points="${points}" style="fill:var(--muted-foreground);"/>`;

    switch (kind) {
        case "left": return win(2, 3, 16, 14) + shade(3, 6, 6, 10) + dashes(9.5, 6, 9.5, 16);
        case "right": return win(2, 3, 16, 14) + shade(11, 6, 6, 10) + dashes(10.5, 6, 10.5, 16);
        case "top": return win(2, 3, 16, 14) + shade(3, 6, 14, 4.5) + dashes(3, 10.5, 17, 10.5);
        case "bottom": return win(2, 3, 16, 14) + shade(3, 11.5, 14, 4.5) + dashes(3, 11.5, 17, 11.5);
        case "center": return win(2, 3, 16, 14) + shade(3, 6, 14, 10);
        // Edge guides: a narrow window at that edge, and an arrow pointing at it
        case "edge-left": return win(2, 3, 7, 14) + arrow("16,7 12,10 16,13");
        case "edge-right": return win(11, 3, 7, 14) + arrow("4,7 8,10 4,13");
        case "edge-top": return win(2, 2, 16, 7) + arrow("7,17 10,13 13,17");
        default: return win(2, 11, 16, 7) + arrow("7,3 10,7 13,3");
    }
}

function createTile(kind) {
    const tile = document.createElement("div");
    tile.style.cssText =
        `position:fixed;z-index:10002;pointer-events:none;width:${TILE}px;height:${TILE}px;` +
        "box-sizing:border-box;border-radius:3px;border:1px solid transparent;" +
        "display:none;align-items:center;justify-content:center;transition:background-color .08s ease;";
    tile.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20">${tileIcon(kind)}</svg>`;
    document.body.appendChild(tile);
    return tile;
}

function createGuides() {
    const guides = { edges: {}, edgePlates: {}, compass: {} };
    for (const side of SIDES) {
        guides.edgePlates[side] = createPlate(CELL + 2 * PAD, `M0.5,0.5H${CELL + 2 * PAD - 0.5}V${CELL + 2 * PAD - 0.5}H0.5Z`);
        guides.edges[side] = createTile(`edge-${side}`);
    }
    guides.plate = createPlate(PLATE, platePath(true));
    for (const side of SIDES) {
        guides.compass[side] = createTile(side);
    }
    guides.compass.center = createTile("center");
    return guides;
}

function show(el, left, top) {
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.display = el.tagName.toLowerCase() === "svg" ? "block" : "flex";
}

function hide(el) {
    el.style.display = "none";
}

// A tile centred on (x, y)
function showTile(tile, x, y) {
    show(tile, x - TILE / 2, y - TILE / 2);
}

function placeGuides(state, x, y) {
    const guides = state.guides || (state.guides = createGuides());
    const r = state.dock.rootEl.getBoundingClientRect();
    const edge = CELL / 2 + PAD + EDGE_INSET;
    const edgeCentres = {
        left: [r.left + edge, r.top + r.height / 2],
        right: [r.right - edge, r.top + r.height / 2],
        top: [r.left + r.width / 2, r.top + edge],
        bottom: [r.left + r.width / 2, r.bottom - edge]
    };
    for (const side of SIDES) {
        const [ex, ey] = edgeCentres[side];
        show(guides.edgePlates[side], ex - CELL / 2 - PAD, ey - CELL / 2 - PAD);
        showTile(guides.edges[side], ex, ey);
    }

    // The guides let the pointer through, so this is the window or page under them
    const groupEl = findClosestAt(state.dock, x, y, "[data-dock-group], [data-dock-page]");
    if (!groupEl) {
        state.compassGroup = null;
        hide(guides.plate);
        Object.values(guides.compass).forEach(hide);
        return;
    }

    const isPage = !groupEl.hasAttribute("data-dock-group");
    const centreOnly = !!groupEl.closest("[data-dock-window]");
    state.compassGroup = {
        id: groupEl.getAttribute(isPage ? "data-dock-page" : "data-dock-group"),
        isPage
    };

    const g = groupEl.getBoundingClientRect();
    const cx = g.left + g.width / 2;
    const cy = g.top + g.height / 2;
    guides.plate.firstChild.setAttribute("d", platePath(!centreOnly));
    show(guides.plate, cx - PLATE / 2, cy - PLATE / 2);

    showTile(guides.compass.center, cx, cy);
    // Greyed over the page: there's no tab in it
    guides.compass.center.style.opacity = isPage ? ".35" : "1";
    if (centreOnly) {
        SIDES.forEach(side => hide(guides.compass[side]));
    } else {
        showTile(guides.compass.left, cx - CELL, cy);
        showTile(guides.compass.right, cx + CELL, cy);
        showTile(guides.compass.top, cx, cy - CELL);
        showTile(guides.compass.bottom, cx, cy + CELL);
    }
}

// The guide's target, in model order (a "left" zone is "before"), so mirrored under dir="rtl" as before
function guideAt(state, x, y, rtl) {
    const guides = state.guides;
    if (!guides) {
        return null;
    }

    const modelZone = side => rtl && (side === "left" || side === "right") ? (side === "left" ? "right" : "left") : side;
    const hit = tile => {
        if (tile.style.display === "none") {
            return false;
        }
        const b = tile.getBoundingClientRect();
        return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
    };

    for (const side of SIDES) {
        if (hit(guides.edges[side])) {
            return { type: "root", zone: modelZone(side), button: guides.edges[side] };
        }
    }

    if (state.compassGroup) {
        for (const side of ["center", ...SIDES]) {
            if (side === "center" && state.compassGroup.isPage) {
                continue;
            }
            if (hit(guides.compass[side])) {
                return {
                    type: "group",
                    groupId: state.compassGroup.id,
                    zone: side === "center" ? "center" : modelZone(side),
                    isPage: state.compassGroup.isPage,
                    button: guides.compass[side]
                };
            }
        }
    }

    return null;
}

// The tile under the pointer lights up, like Visual Studio's
function highlightGuide(state, target) {
    if (!state.guides) {
        return;
    }

    for (const tile of [...Object.values(state.guides.edges), ...Object.values(state.guides.compass)]) {
        const on = tile === target?.button;
        tile.style.background = on ? TILE_HOVER : "transparent";
        tile.style.borderColor = on ? "var(--primary)" : "transparent";
    }
}

function removeGuides(state) {
    if (state.guides) {
        const g = state.guides;
        [...Object.values(g.edges), ...Object.values(g.edgePlates), ...Object.values(g.compass), g.plate].forEach(removeEl);
        state.guides = null;
    }
}

function findClosestAt(dock, x, y, selector) {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
        if (!el.closest) {
            continue;
        }
        const match = el.closest(selector);
        if (match && dock.rootEl.contains(match)) {
            return match;
        }
    }
    return null;
}

// The insertion slot (0..tabCount) for a pointer x over a tab strip, using each tab's midpoint.
function computeInsertIndex(stripEl, x, rtl) {
    const tabs = stripEl.querySelectorAll("[data-dock-tab]");
    for (let i = 0; i < tabs.length; i++) {
        const tr = tabs[i].getBoundingClientRect();
        // Tabs are drawn in model order along the reading direction, so a right-to-left strip
        // reaches the next tab as the pointer moves left.
        const past = rtl ? x > tr.left + tr.width / 2 : x < tr.left + tr.width / 2;
        if (past) {
            return i;
        }
    }
    return tabs.length;
}

function drawIndicator(state, t) {
    if (!t || t.type === "none" || t.type === "float") {
        if (state.indicator) {
            state.indicator.style.display = "none";
        }
        return;
    }

    if (!state.indicator) {
        const ind = document.createElement("div");
        ind.style.cssText =
            // Orca: under the guides (was 10001, now theirs), with squarer corners (was 6px)
            "position:fixed;z-index:10000;pointer-events:none;border-radius:3px;box-sizing:border-box;" +
            "transition:left .07s ease,top .07s ease,width .07s ease,height .07s ease;";
        ind.style.background = ACCENT_BG;
        ind.style.border = ACCENT_BORDER;
        document.body.appendChild(ind);
        state.indicator = ind;
    }

    const ind = state.indicator;
    ind.style.display = "block";
    const rtl = isRtl(state.dock);

    let box;
    if (t.type === "reorder") {
        const stripEl = state.dock.rootEl.querySelector(`[data-dock-tabstrip="${t.groupId}"]`);
        if (!stripEl) {
            ind.style.display = "none";
            return;
        }
        box = insertionLineBox(stripEl, t.index, rtl);
        // A solid caret line between tabs rather than a translucent fill.
        ind.style.background = ACCENT_SOLID;
        ind.style.border = "none";
    } else {
        ind.style.background = ACCENT_BG;
        ind.style.border = ACCENT_BORDER;
        if (t.type === "root") {
            box = zoneBox(state.dock.rootEl.getBoundingClientRect(), t.zone, 0.3, rtl);
        } else {
            // Orca: or the page, where a tool window takes about its usual share rather than half
            const gEl = state.dock.rootEl.querySelector(`[data-dock-group="${t.groupId}"], [data-dock-page="${t.groupId}"]`);
            if (!gEl) {
                ind.style.display = "none";
                return;
            }
            box = zoneBox(gEl.getBoundingClientRect(), t.zone, t.isPage ? 0.3 : 0.5, rtl);
        }
    }

    ind.style.left = `${box.left}px`;
    ind.style.top = `${box.top}px`;
    ind.style.width = `${box.width}px`;
    ind.style.height = `${box.height}px`;
}

function insertionLineBox(stripEl, index, rtl) {
    const tabs = stripEl.querySelectorAll("[data-dock-tab]");
    const sr = stripEl.getBoundingClientRect();
    // The caret sits on the leading edge of the tab the drop would push along, which is the
    // right-hand edge when the strip reads right to left.
    const leading = el => rtl ? el.getBoundingClientRect().right : el.getBoundingClientRect().left;
    const trailing = el => rtl ? el.getBoundingClientRect().left : el.getBoundingClientRect().right;
    let lineX;
    if (tabs.length === 0) {
        lineX = rtl ? sr.right : sr.left;
    } else if (index >= tabs.length) {
        lineX = trailing(tabs[tabs.length - 1]);
    } else {
        lineX = leading(tabs[index]);
    }
    return { left: lineX - 1, top: sr.top, width: 2, height: sr.height };
}

function zoneBox(r, zone, frac, rtl) {
    // The zone names are model order, not screen sides, so they are read back to screen sides
    // through the reading direction — the same mapping computeTarget applied on the way in.
    const side = rtl && (zone === "left" || zone === "right")
        ? (zone === "left" ? "right" : "left")
        : zone;
    switch (side) {
        case "left":
            return { left: r.left, top: r.top, width: r.width * frac, height: r.height };
        case "right":
            return { left: r.right - r.width * frac, top: r.top, width: r.width * frac, height: r.height };
        case "top":
            return { left: r.left, top: r.top, width: r.width, height: r.height * frac };
        case "bottom":
            return { left: r.left, top: r.bottom - r.height * frac, width: r.width, height: r.height * frac };
        default:
            return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
}

function createGhost(title) {
    const g = document.createElement("div");
    g.textContent = title;
    g.style.cssText =
        "position:fixed;z-index:10002;pointer-events:none;padding:4px 10px;font-size:12px;font-weight:500;" +
        "border-radius:6px;background:var(--background);color:var(--foreground);border:1px solid var(--border);" +
        "box-shadow:0 6px 20px rgba(0,0,0,0.28);opacity:.92;" +
        "white-space:nowrap;transform:translate(10px,10px);";
    document.body.appendChild(g);
    return g;
}

function moveGhost(g, x, y) {
    if (g) {
        g.style.left = `${x}px`;
        g.style.top = `${y}px`;
    }
}

function removeEl(el) {
    if (el && el.parentNode) {
        el.parentNode.removeChild(el);
    }
}

// ---------------------------------------------------------------- floating window move

export function startWindowDrag(dockId, windowId, clientX, clientY, pointerId) {
    const dock = docks.get(dockId);
    if (!dock) {
        return;
    }

    const winEl = dock.rootEl.querySelector(`[data-dock-window="${windowId}"]`);
    if (!winEl) {
        return;
    }

    const rootRect = dock.rootEl.getBoundingClientRect();
    const startLeft = parseFloat(winEl.style.left) || 0;
    const startTop = parseFloat(winEl.style.top) || 0;
    const offsetX = clientX - (rootRect.left + startLeft);
    const offsetY = clientY - (rootRect.top + startTop);

    // Orca: the docking guides show here too, so a floating window can be docked again, as in Visual Studio
    const state = { dock, guides: null, indicator: null, compassGroup: null, target: null };
    const clearGuides = () => {
        removeEl(state.indicator);
        removeGuides(state);
        state.indicator = null;
        winEl.style.pointerEvents = "";
    };

    attachSession(dock, pointerId, {
        move: (e) => {
            const left = Math.max(0, e.clientX - rootRect.left - offsetX);
            const top = Math.max(0, e.clientY - rootRect.top - offsetY);
            winEl.style.left = `${left}px`;
            winEl.style.top = `${top}px`;
            // Orca: so the guides and targets see what's under it
            winEl.style.pointerEvents = "none";
            placeGuides(state, e.clientX, e.clientY);
            state.target = computeTarget(state, e.clientX, e.clientY);
            highlightGuide(state, state.target);
            drawIndicator(state, state.target);
        },
        up: () => {
            clearGuides();
            const left = parseFloat(winEl.style.left) || 0;
            const top = parseFloat(winEl.style.top) || 0;
            dropWindow(dock, windowId, winEl, state.target, left, top);
        },
        cancel: () => {
            clearGuides();
            // Cancelled gesture: put the window back where it started, commit nothing.
            winEl.style.left = `${startLeft}px`;
            winEl.style.top = `${startTop}px`;
        }
    });
    document.body.style.cursor = "move";
}

// Orca: a floating window let go: on a guide or a tab strip it docks there (OnWindowDropped), else it stays
// floating where it was let go (OnWindowMoved)
function dropWindow(dock, windowId, winEl, target, left, top) {
    if (winEl) {
        winEl.style.pointerEvents = "";
    }

    const t = target || { type: "float" };
    if (t.type === "root" || t.type === "group" || t.type === "reorder") {
        dock.dotNetRef
            .invokeMethodAsync("OnWindowDropped", windowId, t.type, t.groupId || null, t.zone || "center", typeof t.index === "number" ? t.index : -1)
            .catch(() => { });
        return;
    }

    dock.dotNetRef.invokeMethodAsync("OnWindowMoved", windowId, Math.max(0, left), Math.max(0, top)).catch(() => { });
}

// ---------------------------------------------------------------- floating window resize

// minWidth/minHeight default to the usable window minimum; a max of 0 (or omitted) means
// "no maximum". These mirror the per-panel size constraints enforced on the .NET side.
export function startWindowResize(dockId, windowId, clientX, clientY, pointerId, minWidth, minHeight, maxWidth, maxHeight) {
    const dock = docks.get(dockId);
    if (!dock) {
        return;
    }

    const winEl = dock.rootEl.querySelector(`[data-dock-window="${windowId}"]`);
    if (!winEl) {
        return;
    }

    const minW = minWidth > 0 ? minWidth : 180;
    const minH = minHeight > 0 ? minHeight : 120;
    const maxW = maxWidth > 0 ? maxWidth : Infinity;
    const maxH = maxHeight > 0 ? maxHeight : Infinity;

    const startWidth = winEl.offsetWidth;
    const startHeight = winEl.offsetHeight;
    const startX = clientX;
    const startY = clientY;

    attachSession(dock, pointerId, {
        move: (e) => {
            const width = Math.min(maxW, Math.max(minW, startWidth + (e.clientX - startX)));
            const height = Math.min(maxH, Math.max(minH, startHeight + (e.clientY - startY)));
            winEl.style.width = `${width}px`;
            winEl.style.height = `${height}px`;
        },
        up: () => {
            dock.dotNetRef
                .invokeMethodAsync("OnWindowResized", windowId, winEl.offsetWidth, winEl.offsetHeight)
                .catch(() => { });
        },
        cancel: () => {
            // Cancelled gesture: restore the original size, commit nothing.
            winEl.style.width = `${startWidth}px`;
            winEl.style.height = `${startHeight}px`;
        }
    });
    document.body.style.cursor = "nwse-resize";
}
