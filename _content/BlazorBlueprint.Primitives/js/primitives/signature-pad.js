/**
 * Ink engine for the signature pad primitive.
 *
 * A signature drawn as straight lines between pointer samples looks like a mouse scribble. What
 * makes it read as ink is two things: the path is a smooth Bezier through the samples rather than
 * a polyline, and the stroke thins as the pen moves faster. Both are done here, in the browser —
 * C# hears one call when a stroke finishes, never while one is being drawn.
 *
 * Geometry is the only thing stored. Colour is resolved from the element at render time, so the
 * same signature redraws in the current theme and the exported SVG can use `currentColor` rather
 * than baking in a white stroke that vanishes on white paper.
 */

const padStates = new Map();

/** Sub-steps per pixel of curve length when filling a curve with dots. Below this it bands. */
const CURVE_STEPS_PER_PIXEL = 2;

/** Samples used to approximate a curve's arc length. Enough to pick a step count from. */
const LENGTH_SAMPLES = 10;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** Speed between two samples in pixels per millisecond, zero when they share a timestamp. */
function velocityBetween(a, b) {
    const elapsed = b.t - a.t;
    return elapsed > 0 ? distance(a, b) / elapsed : 0;
}

/**
 * The two Bezier control points for the middle of three samples.
 *
 * Each pair of samples contributes its midpoint; the midpoints are shifted so that the curve
 * passes through the middle sample rather than cutting the corner, and weighted by segment length
 * so a long segment followed by a short one does not overshoot.
 */
function controlPoints(s1, s2, s3) {
    const m1 = { x: (s1.x + s2.x) / 2, y: (s1.y + s2.y) / 2 };
    const m2 = { x: (s2.x + s3.x) / 2, y: (s2.y + s3.y) / 2 };

    const l1 = distance(s1, s2);
    const l2 = distance(s2, s3);
    const k = l1 + l2 > 0 ? l2 / (l1 + l2) : 0;

    const centre = { x: m2.x + (m1.x - m2.x) * k, y: m2.y + (m1.y - m2.y) * k };
    const shiftX = s2.x - centre.x;
    const shiftY = s2.y - centre.y;

    return [
        { x: m1.x + shiftX, y: m1.y + shiftY },
        { x: m2.x + shiftX, y: m2.y + shiftY }
    ];
}

const bezierAt = (t, p0, p1, p2, p3) => {
    const u = 1 - t;
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

const pointOnCurve = (curve, t) => ({
    x: bezierAt(t, curve.start.x, curve.c1.x, curve.c2.x, curve.end.x),
    y: bezierAt(t, curve.start.y, curve.c1.y, curve.c2.y, curve.end.y)
});

function curveLength(curve) {
    let length = 0;
    let previous = curve.start;
    for (let i = 1; i <= LENGTH_SAMPLES; i++) {
        const current = pointOnCurve(curve, i / LENGTH_SAMPLES);
        length += distance(previous, current);
        previous = current;
    }
    return length;
}

// ---------------------------------------------------------------------------
// Stroke building
// ---------------------------------------------------------------------------

/**
 * Resets the incremental state a stroke needs to turn samples into curves.
 *
 * The same routine runs for a stroke being drawn and for one being replayed on resize, undo or
 * export, so a redrawn signature is identical to the one that was drawn.
 */
function beginStroke(stroke, pen) {
    stroke.buffer = [];
    stroke.lastVelocity = 0;
    stroke.lastWidth = (pen.minWidth + pen.maxWidth) / 2;
}

/** Half-widths for the segment between two samples: faster movement means a thinner line. */
function curveWidths(stroke, pen, from, to) {
    const velocity = pen.velocityWeight * velocityBetween(from, to)
        + (1 - pen.velocityWeight) * stroke.lastVelocity;
    const width = Math.max(pen.maxWidth / (velocity + 1), pen.minWidth);

    const widths = { start: stroke.lastWidth, end: width };
    stroke.lastVelocity = velocity;
    stroke.lastWidth = width;
    return widths;
}

/**
 * Feeds one sample into a stroke and returns the curve it completes, if any.
 *
 * A cubic needs four samples: the curve runs between the middle two, with a control point taken
 * from the sample on either side. The first three are padded by repeating the first, so a stroke
 * starts drawing on its third sample instead of its fourth.
 *
 * @returns {object|null} The completed curve, or null while the buffer is still filling.
 */
function feedStroke(stroke, pen, sample) {
    const buffer = stroke.buffer;
    buffer.push(sample);

    if (buffer.length <= 2) return null;
    if (buffer.length === 3) buffer.unshift(buffer[0]);

    const widths = curveWidths(stroke, pen, buffer[1], buffer[2]);
    const curve = {
        start: buffer[1],
        c1: controlPoints(buffer[0], buffer[1], buffer[2])[1],
        c2: controlPoints(buffer[1], buffer[2], buffer[3])[0],
        end: buffer[2],
        startWidth: widths.start,
        endWidth: widths.end
    };

    buffer.shift();
    return curve;
}

/** Replays a finished stroke, handing every curve to a visitor. */
function replayStroke(stroke, pen, visit) {
    const replay = { buffer: [], lastVelocity: 0, lastWidth: 0 };
    beginStroke(replay, pen);
    for (const sample of stroke.points) {
        const curve = feedStroke(replay, pen, sample);
        if (curve) visit(curve);
    }
}

const isDot = stroke => stroke.points.length < 3;

// ---------------------------------------------------------------------------
// Canvas rendering
// ---------------------------------------------------------------------------

/**
 * Fills a curve with overlapping dots of interpolated radius.
 *
 * A variable-width line cannot be stroked in one call, so the curve is walked and a circle is
 * dropped at each step. The width follows t cubed rather than t so that the change bunches
 * towards the end of the segment, which is where the next segment picks it up.
 */
function drawCurve(ctx, curve, colour) {
    const widthDelta = curve.endWidth - curve.startWidth;
    const steps = Math.max(Math.ceil(curveLength(curve)) * CURVE_STEPS_PER_PIXEL, 1);

    ctx.beginPath();
    ctx.fillStyle = colour;
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const { x, y } = pointOnCurve(curve, t);
        const radius = curve.startWidth + t * t * t * widthDelta;
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
    ctx.fill();
}

function drawDot(ctx, stroke, pen, colour) {
    const { x, y } = stroke.points[0];
    ctx.beginPath();
    ctx.fillStyle = colour;
    ctx.arc(x, y, (pen.minWidth + pen.maxWidth) / 2, 0, Math.PI * 2);
    ctx.fill();
}

function drawStroke(ctx, stroke, pen, colour) {
    if (isDot(stroke)) {
        drawDot(ctx, stroke, pen, colour);
        return;
    }
    replayStroke(stroke, pen, curve => drawCurve(ctx, curve, colour));
}

function redraw(state) {
    const { ctx, canvas } = state;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const colour = penColour(state);
    for (const stroke of state.strokes) {
        drawStroke(ctx, stroke, pen(state), colour);
    }
}

// ---------------------------------------------------------------------------
// Element-driven settings
// ---------------------------------------------------------------------------

function numberAttribute(element, name, fallback) {
    const raw = element.getAttribute(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    return Number.isNaN(value) ? fallback : value;
}

const pen = state => ({
    minWidth: numberAttribute(state.canvas, 'data-min-width', 0.5),
    maxWidth: numberAttribute(state.canvas, 'data-max-width', 2.5),
    velocityWeight: numberAttribute(state.canvas, 'data-velocity-weight', 0.7)
});

/**
 * The ink colour: an explicit one when set, otherwise the element's own CSS `color`.
 *
 * Falling back to `color` is what lets a signature follow the theme without the consumer wiring
 * anything up, and it is the same value the exported SVG stands in for with `currentColor`.
 */
function penColour(state) {
    const explicit = state.canvas.getAttribute('data-colour');
    return explicit || getComputedStyle(state.canvas).color || '#000';
}

/**
 * Sizes the backing store for the device's pixel ratio and redraws.
 *
 * Samples are stored in CSS pixels, so a resize or a move between monitors only has to rescale
 * the context and replay them. Resizing a canvas also clears it, which is why the redraw is not
 * optional.
 */
function resize(state) {
    const { canvas } = state;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    state.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    state.cssWidth = rect.width;
    state.cssHeight = rect.height;
    redraw(state);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Starts capturing signatures on a canvas.
 *
 * @param {HTMLCanvasElement} canvas - The drawing surface.
 * @param {DotNetObject} dotNetRef - Reference to the BbSignaturePad component.
 * @param {string} padId - Unique identifier for this pad.
 */
export function initialize(canvas, dotNetRef, padId) {
    if (!canvas || !dotNetRef) return;
    dispose(padId);

    const state = {
        canvas,
        ctx: canvas.getContext('2d'),
        dotNetRef,
        strokes: [],
        current: null,
        pointerId: null,
        cssWidth: 0,
        cssHeight: 0,
        disposed: false
    };

    const disabled = () => canvas.getAttribute('data-disabled') === 'true';
    const notify = () => {
        if (state.disposed) return;
        dotNetRef.invokeMethodAsync('JsSignatureChanged', state.strokes.length === 0)
            .catch(() => { }); // A disconnected circuit must not break the pad.
    };

    const sampleFrom = event => {
        const rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top, t: event.timeStamp };
    };

    const down = event => {
        if (state.pointerId != null || disabled() || !event.isPrimary || event.button > 0) return;
        event.preventDefault();
        state.pointerId = event.pointerId;
        canvas.setPointerCapture(event.pointerId);

        state.current = { points: [] };
        beginStroke(state.current, pen(state));
        addSample(sampleFrom(event));
    };

    const addSample = sample => {
        const stroke = state.current;
        stroke.points.push(sample);
        const curve = feedStroke(stroke, pen(state), sample);
        if (curve) drawCurve(state.ctx, curve, penColour(state));
    };

    const move = event => {
        if (event.pointerId !== state.pointerId) return;
        event.preventDefault();
        // A pen or a high-rate mouse reports several positions between frames. Using them all
        // costs nothing here and is the difference between a smooth curve and a faceted one.
        const events = typeof event.getCoalescedEvents === 'function'
            ? event.getCoalescedEvents()
            : [event];
        for (const point of events.length > 0 ? events : [event]) {
            addSample(sampleFrom(point));
        }
    };

    const up = event => {
        if (event.pointerId !== state.pointerId) return;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        state.pointerId = null;

        const stroke = state.current;
        state.current = null;
        if (!stroke) return;

        // A tap leaves a dot. Two samples cannot make a cubic, so it is drawn as one.
        if (isDot(stroke)) drawDot(state.ctx, stroke, pen(state), penColour(state));
        state.strokes.push({ points: stroke.points });
        notify();
    };

    const listeners = {
        pointerdown: down,
        pointermove: move,
        pointerup: up,
        pointercancel: up,
        lostpointercapture: up
    };
    Object.entries(listeners).forEach(([event, handler]) => canvas.addEventListener(event, handler));

    const resizeObserver = new ResizeObserver(() => resize(state));
    resizeObserver.observe(canvas);

    // The ink colour comes from CSS, so a theme change has to repaint what is already drawn.
    const themeObserver = new MutationObserver(() => redraw(state));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

    resize(state);

    padStates.set(padId, {
        state,
        dispose: () => {
            state.disposed = true;
            resizeObserver.disconnect();
            themeObserver.disconnect();
            if (state.pointerId != null && canvas.hasPointerCapture(state.pointerId)) {
                canvas.releasePointerCapture(state.pointerId);
            }
            Object.entries(listeners).forEach(([event, handler]) => canvas.removeEventListener(event, handler));
        }
    });
}

/** Erases every stroke. */
export function clear(padId) {
    const entry = padStates.get(padId);
    if (!entry) return;
    entry.state.strokes = [];
    entry.state.current = null;
    redraw(entry.state);
}

/** Removes the most recent stroke. Returns true when there was one to remove. */
export function undo(padId) {
    const entry = padStates.get(padId);
    if (!entry || entry.state.strokes.length === 0) return false;
    entry.state.strokes.pop();
    redraw(entry.state);
    return true;
}

/** Whether nothing has been drawn. */
export function isEmpty(padId) {
    const entry = padStates.get(padId);
    return !entry || entry.state.strokes.length === 0;
}

/**
 * The signature as SVG, or null when nothing is drawn.
 *
 * Each curve becomes one path at its own width rather than the thousands of dots the canvas
 * draws, which keeps the file small while preserving the taper. The stroke is `currentColor`, so
 * the same markup renders dark on paper and light on a dark page.
 */
export function toSvg(padId) {
    const entry = padStates.get(padId);
    if (!entry || entry.state.strokes.length === 0) return null;

    const state = entry.state;
    const settings = pen(state);
    // One decimal place is finer than a device pixel at any sane zoom, and every digit is paid for
    // once per coordinate — of which a detailed signature has thousands.
    const round = value => Math.round(value * 10) / 10;
    const parts = [];

    for (const stroke of state.strokes) {
        if (isDot(stroke)) {
            const { x, y } = stroke.points[0];
            const r = round((settings.minWidth + settings.maxWidth) / 2);
            // A dot is the one filled shape here, so it overrides the group's fill.
            parts.push(`<circle cx="${round(x)}" cy="${round(y)}" r="${r}" fill="currentColor"/>`);
            continue;
        }
        replayStroke(stroke, settings, curve => {
            const d = `M${round(curve.start.x)} ${round(curve.start.y)}`
                + `C${round(curve.c1.x)} ${round(curve.c1.y)} `
                + `${round(curve.c2.x)} ${round(curve.c2.y)} `
                + `${round(curve.end.x)} ${round(curve.end.y)}`;
            // Canvas widths are radii; an SVG stroke is measured across, so it is twice the mean.
            parts.push(`<path d="${d}" stroke-width="${round(curve.startWidth + curve.endWidth)}"/>`);
        });
    }

    const width = round(state.cssWidth);
    const height = round(state.cssHeight);
    // width and height give it an intrinsic size, which is what an <img> tag and a PDF need. The
    // inline style is for the other case: dropped straight into a page, a pad drawn at 1500px
    // would otherwise overflow its container and be cut off rather than shrink to fit.
    //
    // The paint is hoisted onto a <g> rather than repeated on every path. It is identical on all
    // of them, and a detailed signature has thousands, so repeating it more than doubles the file.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
        + `viewBox="0 0 ${width} ${height}" style="max-width:100%;height:auto">`
        + `<g fill="none" stroke="currentColor" stroke-linecap="round">`
        + `${parts.join('')}</g></svg>`;
}

/**
 * The signature as a PNG data URL, or null when nothing is drawn.
 *
 * The strokes are redrawn at the requested colour rather than copied off the live canvas. Copying
 * would bake in the theme's ink, and a signature drawn in a dark theme is near-white: composite
 * that onto the white background a PDF wants and the result is a blank page. SVG escapes this with
 * `currentColor`; a PNG has nowhere to defer the decision to, so the colour is always explicit.
 *
 * @param {string|null} background - A CSS colour to fill behind the ink, or null for transparency.
 * @param {string} ink - A CSS colour for the strokes.
 */
function renderForExport(padId, background, ink) {
    const entry = padStates.get(padId);
    if (!entry || entry.state.strokes.length === 0) return null;
    const state = entry.state;

    const copy = document.createElement('canvas');
    copy.width = state.canvas.width;
    copy.height = state.canvas.height;

    const ctx = copy.getContext('2d');
    const ratio = state.canvas.width / (state.cssWidth || state.canvas.width);
    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, copy.width, copy.height);
    }

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const settings = pen(state);
    const colour = ink || penColour(state);
    for (const stroke of state.strokes) {
        drawStroke(ctx, stroke, settings, colour);
    }

    return copy;
}

/** The raw samples, for storing a signature that can be replayed or checked later. */
export function getStrokes(padId) {
    const entry = padStates.get(padId);
    if (!entry) return [];
    return entry.state.strokes.map(stroke => ({
        points: stroke.points.map(p => ({ x: p.x, y: p.y, t: p.t }))
    }));
}

/** Replaces the drawing with previously captured samples. */
export function setStrokes(padId, strokes) {
    const entry = padStates.get(padId);
    if (!entry) return;
    entry.state.strokes = (strokes ?? [])
        .map(stroke => ({ points: (stroke.points ?? []).map(p => ({ x: p.x, y: p.y, t: p.t })) }))
        .filter(stroke => stroke.points.length > 0);
    redraw(entry.state);
}

// ---------------------------------------------------------------------------
// Streamed exports
// ---------------------------------------------------------------------------

/**
 * Everything that leaves this module for C# goes as a stream rather than as a return value.
 *
 * A Blazor Server circuit caps an incoming hub message at 32KB by default, and a detailed
 * signature blows straight past it: 400 samples is roughly 400 curves, and the SVG, the PNG and
 * even the raw samples all clear the cap. The failure is silent and total — the circuit is torn
 * down mid-call, so the component never gets its answer and the page simply stops responding.
 * Streams are chunked by the framework and are not subject to the cap.
 *
 * Each of these returns the bytes as a plain typed array. Blazor builds the stream itself when the
 * calling side asks for an IJSStreamReference; wrapping it here with createJSStreamReference gets
 * wrapped a second time and fails with "Supplied value is not a typed array or blob."
 */

const utf8 = new TextEncoder();

/** The SVG markup as UTF-8 bytes, or null when nothing is drawn. */
export function toSvgStream(padId) {
    const svg = toSvg(padId);
    return svg === null ? null : utf8.encode(svg);
}

/** The raw samples as UTF-8 JSON bytes. */
export function toStrokesStream(padId) {
    return utf8.encode(JSON.stringify(getStrokes(padId)));
}

/**
 * The PNG as a stream of its bytes, or null when nothing is drawn.
 *
 * Built through toBlob rather than toDataURL so the bytes are never base64 on this side: the
 * encoding is a third larger and C# has to undo it anyway.
 */
export async function toPngStream(padId, background, ink) {
    const canvas = renderForExport(padId, background, ink);
    if (!canvas) return null;

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
}

/** Removes every listener and observer for a pad. */
export function dispose(padId) {
    padStates.get(padId)?.dispose();
    padStates.delete(padId);
}
