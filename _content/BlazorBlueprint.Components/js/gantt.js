// Bar gestures stay in the browser. Only the finished gesture crosses the Blazor circuit, because
// a pointermove per frame over a server circuit is a bar that lags behind the pointer.
const instances = new WeakMap();

/** @returns {boolean} Whether the chart reads right to left. */
function isRtl(root) {
    return getComputedStyle(root).direction === 'rtl';
}

/**
 * How far the pointer has travelled along the timeline, in the direction time runs.
 * @param {HTMLElement} root - The chart's scrolling container.
 * @param {number} from - Where the gesture started, in client pixels.
 * @param {number} to - Where the pointer is now, in client pixels.
 * @returns {number} The distance in pixels, positive towards later.
 */
function travelled(root, from, to) {
    return isRtl(root) ? from - to : to - from;
}

/**
 * Scroll the timeline so that a content position sits in the middle of the visible timeline.
 * @param {HTMLElement} root - The scrolling container.
 * @param {number} x - The position, measured from the content's start edge.
 * @param {number} stickyWidth - How much of the viewport the task list covers.
 */
export function scrollTo(root, x, stickyWidth) {
    if (!root) return;
    // The task list sits over the first stickyWidth pixels, so the timeline the reader can
    // actually see is narrower than the container by exactly that much.
    const visible = Math.max(0, root.clientWidth - stickyWidth);
    const target = Math.max(0, x - stickyWidth - visible / 2);
    // Scrolling away from the start edge is negative in a right-to-left box.
    root.scrollLeft = isRtl(root) ? -target : target;
}

/**
 * Wire up dragging, resizing, progress and dependency drawing.
 * @param {HTMLElement} root - The chart's scrolling container.
 * @param {object} dotNet - The Blazor component reference.
 */
export function initialize(root, dotNet) {
    if (!root || !dotNet) return;
    if (instances.has(root)) {
        instances.get(root).dotNet = dotNet;
        return;
    }

    const state = { dotNet, gesture: null, suppressClickUntil: 0 };
    instances.set(root, state);

    const allowed = action => root.dataset[{
        move: 'allowDrag',
        start: 'allowResize',
        end: 'allowResize',
        progress: 'allowProgress',
        link: 'allowLink',
    }[action]] === 'true';

    const restore = gesture => {
        gesture.bar.style.insetInlineStart = gesture.inlineStart;
        gesture.bar.style.width = gesture.width;
        if (gesture.fill) gesture.fill.style.width = gesture.fillWidth;
        gesture.preview?.remove();
    };

    const slotsMoved = (gesture, clientX) => {
        const slotWidth = Number(root.dataset.slotWidth) || 1;
        const raw = travelled(root, gesture.startX, clientX) / slotWidth;
        return root.dataset.snap === 'true' ? Math.round(raw) : raw;
    };

    // How far along a bar the pointer is, measured from whichever end the task starts at.
    const fractionAt = (bar, clientX) => {
        const rect = bar.getBoundingClientRect();
        if (rect.width <= 0) return 0;
        const along = isRtl(root) ? rect.right - clientX : clientX - rect.left;
        return Math.min(1, Math.max(0, along / rect.width));
    };

    // ── Row dragging ───────────────────────────────────────────────────────

    const dropAt = (event) => {
        const hit = document.elementFromPoint(event.clientX, event.clientY);
        const cell = hit?.closest('[data-gantt-row]');
        if (!cell || !root.contains(cell)) return null;

        // Top and bottom quarters reorder, the middle re-parents. A quarter rather than a third
        // because most drops mean "put it here", not "put it inside".
        const rect = cell.getBoundingClientRect();
        const share = (event.clientY - rect.top) / rect.height;
        const position = share < 0.25 ? 'before' : share > 0.75 ? 'after' : 'inside';
        return { id: cell.dataset.ganttRow, cell, position };
    };

    const showDrop = drop => {
        const box = root.querySelector('table')?.parentElement;
        if (!box) return;

        let mark = state.indicator;
        if (!mark) {
            mark = document.createElement('div');
            mark.dataset.ganttDrop = '';
            Object.assign(mark.style, { position: 'absolute', pointerEvents: 'none', zIndex: '50' });
            box.append(mark);
            state.indicator = mark;
        }

        if (!drop) {
            mark.style.display = 'none';
            return;
        }

        const rect = drop.cell.getBoundingClientRect();
        const origin = box.getBoundingClientRect();
        const top = rect.top - origin.top;
        Object.assign(mark.style, {
            display: '',
            insetInlineStart: '0',
            // The content box is exactly the chart's width, so the mark runs the whole row rather
            // than stopping at the edge of the task list.
            width: '100%',
            top: drop.position === 'after' ? `${top + rect.height - 1}px` : `${top}px`,
            height: drop.position === 'inside' ? `${rect.height}px` : '2px',
            background: drop.position === 'inside' ? 'color-mix(in oklab, var(--primary) 18%, transparent)' : 'var(--primary)',
            border: drop.position === 'inside' ? '1px solid var(--primary)' : 'none',
            borderRadius: drop.position === 'inside' ? '3px' : '0',
        });
    };

    const clearDrop = () => {
        state.indicator?.remove();
        state.indicator = null;
    };

    const onDown = event => {
        if (event.button !== 0 || state.gesture) return;

        const handle = event.target.closest('[data-gantt-row-handle]');
        if (handle && root.dataset.allowRowDrag === 'true') {
            const cell = handle.closest('[data-gantt-row]');
            if (!cell) return;
            event.preventDefault();
            state.gesture = { action: 'row', id: cell.dataset.ganttRow, pointerId: event.pointerId, moved: false };
            try { handle.setPointerCapture(event.pointerId); } catch { /* capture is a nicety */ }
            state.handle = handle;
            return;
        }

        const bar = event.target.closest('[data-gantt-bar]');
        if (!bar || !root.contains(bar)) return;

        const connector = event.target.closest('[data-gantt-link]');
        const action = connector
            ? 'link'
            : event.target.closest('[data-gantt-progress]')
                ? 'progress'
                : event.target.closest('[data-gantt-resize]')?.dataset.ganttResize ?? 'move';

        if (!allowed(action)) return;

        event.preventDefault();

        const fill = bar.querySelector('[data-gantt-fill]');
        state.gesture = {
            bar,
            fill,
            action,
            anchor: connector?.dataset.ganttLink,
            id: bar.dataset.ganttBar,
            pointerId: event.pointerId,
            startX: event.clientX,
            // The inline styles as Blazor wrote them. A refused gesture has to put them back
            // verbatim: Blazor only patches what it believes changed, and it does not know this
            // file touched anything.
            inlineStart: bar.style.insetInlineStart,
            width: bar.style.width,
            fillWidth: fill ? fill.style.width : '',
            originalStart: parseFloat(bar.style.insetInlineStart) || 0,
            originalWidth: parseFloat(bar.style.width) || 0,
            moved: false,
        };

        try { bar.setPointerCapture(event.pointerId); } catch { /* capture is a nicety */ }
    };

    // A straight line from the connector to the pointer, drawn in its own overlay in client
    // coordinates. The arrows themselves are mirrored in a right-to-left page and a preview
    // sharing that coordinate system would run the wrong way.
    const drawPreview = (gesture, clientX, clientY) => {
        const layer = gesture.bar.parentElement;
        if (!gesture.preview) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('aria-hidden', 'true');
            svg.dataset.ganttPreview = '';
            Object.assign(svg.style, {
                position: 'absolute', inset: '0', width: '100%', height: '100%',
                pointerEvents: 'none', overflow: 'visible', direction: 'ltr',
            });
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('stroke', 'currentColor');
            line.setAttribute('stroke-width', '1.5');
            line.setAttribute('stroke-dasharray', '4 3');
            svg.append(line);
            layer.append(svg);
            gesture.preview = svg;
        }

        const box = layer.getBoundingClientRect();
        const from = gesture.bar.getBoundingClientRect();
        const line = gesture.preview.firstElementChild;
        line.setAttribute('x1', (gesture.anchor === 'start' ? from.left : from.right) - box.left);
        line.setAttribute('y1', from.top + from.height / 2 - box.top);
        line.setAttribute('x2', clientX - box.left);
        line.setAttribute('y2', clientY - box.top);
    };

    const onMove = event => {
        const gesture = state.gesture;
        if (!gesture || event.pointerId !== gesture.pointerId) return;

        if (gesture.action === 'row') {
            gesture.moved = true;
            const drop = dropAt(event);
            gesture.drop = drop && drop.id !== gesture.id ? drop : null;
            showDrop(gesture.drop);
            return;
        }

        if (event.clientX !== gesture.startX) gesture.moved = true;

        if (gesture.action === 'link') {
            drawPreview(gesture, event.clientX, event.clientY);
            return;
        }

        if (gesture.action === 'progress') {
            if (gesture.fill) gesture.fill.style.width = `${fractionAt(gesture.bar, event.clientX) * 100}%`;
            return;
        }

        const slotWidth = Number(root.dataset.slotWidth) || 1;
        const offset = slotsMoved(gesture, event.clientX) * slotWidth;

        if (gesture.action === 'move') {
            gesture.bar.style.insetInlineStart = `${gesture.originalStart + offset}px`;
        } else if (gesture.action === 'start') {
            // Never past the far end: a bar dragged inside out is a task that finishes before it
            // starts, and the reader cannot see what they are asking for.
            const width = Math.max(2, gesture.originalWidth - offset);
            gesture.bar.style.insetInlineStart = `${gesture.originalStart + gesture.originalWidth - width}px`;
            gesture.bar.style.width = `${width}px`;
        } else {
            gesture.bar.style.width = `${Math.max(2, gesture.originalWidth + offset)}px`;
        }
    };

    const onUp = event => {
        const gesture = state.gesture;
        if (!gesture || event.pointerId !== gesture.pointerId) return;

        if (gesture.action === 'row') {
            state.gesture = null;
            try { state.handle?.releasePointerCapture(event.pointerId); } catch { /* already gone */ }
            state.handle = null;
            const drop = gesture.drop;
            clearDrop();
            if (!gesture.moved || !drop) return;
            state.suppressClickUntil = Date.now() + 300;
            state.dotNet
                .invokeMethodAsync('OnRowDropped', gesture.id, drop.id, drop.position)
                .catch(() => { /* the component may be gone */ });
            return;
        }

        state.gesture = null;
        try { gesture.bar.releasePointerCapture(event.pointerId); } catch { /* already gone */ }

        const target = gesture.action === 'link' ? barUnder(event) : null;
        restore(gesture);

        if (!gesture.moved) return;

        // A gesture that ends on the bar would otherwise also read as a click on it.
        state.suppressClickUntil = Date.now() + 300;

        const failed = () => { /* the component may be gone */ };

        if (gesture.action === 'link') {
            if (!target || target.dataset.ganttBar === gesture.id) return;
            // Dropped on the first half of a bar means its start, on the second half its end.
            const toAnchor = fractionAt(target, event.clientX) < 0.5 ? 'start' : 'end';
            state.dotNet
                .invokeMethodAsync('OnLinkDrawn', gesture.id, gesture.anchor, target.dataset.ganttBar, toAnchor)
                .catch(failed);
            return;
        }

        if (gesture.action === 'progress') {
            state.dotNet
                .invokeMethodAsync('OnProgressDragged', gesture.id, fractionAt(gesture.bar, event.clientX))
                .catch(failed);
            return;
        }

        state.dotNet
            .invokeMethodAsync('OnBarDragged', gesture.id, gesture.action, slotsMoved(gesture, event.clientX))
            .catch(failed);
    };

    // Pointer capture keeps every move on the source bar, so the drop target has to be found by
    // asking what is under the pointer rather than by reading the event's own target.
    const barUnder = event => {
        const hit = document.elementFromPoint(event.clientX, event.clientY);
        const bar = hit?.closest('[data-gantt-bar]');
        return bar && root.contains(bar) ? bar : null;
    };

    const onCancel = () => {
        if (!state.gesture) return;
        if (state.gesture.action === 'row') {
            clearDrop();
        } else {
            restore(state.gesture);
        }

        state.gesture = null;
    };

    const onClick = event => {
        if (Date.now() < state.suppressClickUntil) {
            event.stopPropagation();
            event.preventDefault();
        }
    };

    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onCancel);
    root.addEventListener('click', onClick, true);

    state.teardown = () => {
        clearDrop();
        root.removeEventListener('pointerdown', onDown);
        root.removeEventListener('pointermove', onMove);
        root.removeEventListener('pointerup', onUp);
        root.removeEventListener('pointercancel', onCancel);
        root.removeEventListener('click', onClick, true);
    };
}

/**
 * Drop the handlers for a chart.
 * @param {HTMLElement} root - The chart's scrolling container.
 */
export function dispose(root) {
    const state = root && instances.get(root);
    if (!state) return;
    state.teardown?.();
    instances.delete(root);
}
