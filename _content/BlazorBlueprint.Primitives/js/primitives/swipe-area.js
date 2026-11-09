import { createDragUpdates } from '../drag-updates.js';

const areaStates = new Map();

/**
 * A flick may commit below the distance threshold, but a tap must not. A 3px wobble over 5ms
 * reads as 0.6 px/ms, which clears any velocity bar worth setting, so the velocity path carries
 * its own floor on distance.
 */
const FLICK_MIN_DISTANCE = 16;

/**
 * Velocity is measured against the oldest sample still inside this window rather than across the
 * whole gesture, so a finger that travels far and then rests before lifting does not report the
 * speed it started with.
 */
const VELOCITY_WINDOW_MS = 100;

/**
 * Watches an element for swipe gestures and reports them to Blazor.
 *
 * The gesture maths stays here. C# hears at most one throttled update per 50ms while the finger
 * moves — and only when the component has an OnSwipeMove handler — plus exactly one terminal
 * call. On Blazor Server that is the difference between a handful of circuit messages and one
 * per pointermove.
 *
 * Tunables are read from data attributes on each event rather than captured at initialize, so a
 * parameter change on the C# side takes effect without a second interop call.
 *
 * @param {HTMLElement} element - The element to watch.
 * @param {DotNetObject} dotNetRef - Reference to the BbSwipeArea component.
 * @param {string} areaId - Unique identifier for this area.
 */
export function initialize(element, dotNetRef, areaId) {
    if (!element || !dotNetRef) return;
    dispose(areaId);

    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let samples = [];
    let reportedMove = false;
    let disposed = false;

    const moves = createDragUpdates((x, y) => dotNetRef.invokeMethodAsync('JsSwipeMove', x, y));

    // Rejects only what does not parse, so that Infinity survives: it is how MinVelocity turns
    // the flick path off, and Number.isFinite would quietly swap it for the default.
    const attribute = (name, fallback) => {
        const raw = element.getAttribute(name);
        if (raw === null) return fallback;
        const value = Number(raw);
        return Number.isNaN(value) ? fallback : value;
    };
    const disabled = () => element.getAttribute('data-disabled') === 'true';
    const axis = () => element.getAttribute('data-axis') ?? 'both';
    const reportsMove = () => element.getAttribute('data-report-move') === 'true';

    const reset = () => {
        pointerId = null;
        samples = [];
        reportedMove = false;
    };

    const release = e => {
        if (element.hasPointerCapture(e.pointerId)) element.releasePointerCapture(e.pointerId);
    };

    /** The component's own axis lock, falling back to whichever axis the gesture favoured. */
    const isHorizontal = (dx, dy) => {
        const locked = axis();
        if (locked === 'horizontal') return true;
        if (locked === 'vertical') return false;
        return Math.abs(dx) >= Math.abs(dy);
    };

    const down = e => {
        if (pointerId != null || disabled() || !e.isPrimary || e.button > 0) return;
        pointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        samples = [{ x: e.clientX, y: e.clientY, t: e.timeStamp }];
        reportedMove = false;
        // Capture keeps the gesture alive once the finger leaves the element, which is what lets
        // a swipe that runs off the edge still count instead of silently dying there.
        element.setPointerCapture(pointerId);
        moves.begin();
    };

    const move = e => {
        if (e.pointerId !== pointerId) return;
        samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
        // Keep the oldest sample that is still older than the window, so the window is always
        // covered rather than just approached.
        while (samples.length > 2 && e.timeStamp - samples[1].t >= VELOCITY_WINDOW_MS) samples.shift();
        if (!reportsMove()) return;
        reportedMove = true;
        moves.push([e.clientX - startX, e.clientY - startY]);
    };

    const up = async e => {
        if (e.pointerId !== pointerId) return;
        release(e);

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const horizontal = isHorizontal(dx, dy);
        const primary = horizontal ? dx : dy;
        const distance = Math.abs(primary);

        const oldest = samples[0] ?? { x: startX, y: startY, t: e.timeStamp };
        const elapsed = Math.max(1, e.timeStamp - oldest.t);
        const recent = horizontal ? e.clientX - oldest.x : e.clientY - oldest.y;
        const velocity = Math.abs(recent) / elapsed;

        const threshold = attribute('data-threshold', 50);
        const minVelocity = attribute('data-min-velocity', 0.5);
        const committed = distance >= threshold
            || (distance >= FLICK_MIN_DISTANCE && velocity >= minVelocity);
        const hadMove = reportedMove;

        reset();
        // Let the last move update land first, so a consumer animating from OnSwipeMove never
        // sees a stale offset arrive after the gesture it belongs to has already ended.
        await moves.flush();
        if (disposed) return;

        if (committed) {
            const direction = horizontal
                ? (primary < 0 ? 'Left' : 'Right')
                : (primary < 0 ? 'Up' : 'Down');
            dotNetRef.invokeMethodAsync('JsSwipeEnd', direction, dx, dy, distance, velocity);
        } else if (hadMove) {
            // A consumer that animated the drag needs a signal to spring back from. One that only
            // listens for a completed swipe is told nothing, because nothing happened.
            dotNetRef.invokeMethodAsync('JsSwipeCancel');
        }
    };

    const abort = async e => {
        if (e.pointerId !== pointerId) return;
        release(e);
        reset();
        await moves.flush();
        if (!disposed) dotNetRef.invokeMethodAsync('JsSwipeCancel');
    };

    const listeners = {
        pointerdown: down,
        pointermove: move,
        pointerup: up,
        pointercancel: abort,
        lostpointercapture: abort
    };
    Object.entries(listeners).forEach(([event, handler]) => element.addEventListener(event, handler));

    areaStates.set(areaId, {
        cancel: () => {
            if (pointerId == null) return;
            if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
            reset();
            moves.cancel();
        },
        dispose: () => {
            disposed = true;
            moves.dispose();
            if (pointerId != null && element.hasPointerCapture(pointerId)) {
                element.releasePointerCapture(pointerId);
            }
            Object.entries(listeners).forEach(([event, handler]) => element.removeEventListener(event, handler));
        }
    });
}

/**
 * Abandons a gesture in progress without reporting it. Does nothing when none is running.
 * @param {string} areaId - The area to cancel.
 */
export function cancel(areaId) {
    areaStates.get(areaId)?.cancel();
}

/**
 * Removes every listener for an area.
 * @param {string} areaId - The area to dispose.
 */
export function dispose(areaId) {
    areaStates.get(areaId)?.dispose();
    areaStates.delete(areaId);
}
