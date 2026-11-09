/**
 * Arms the browser's own "leave site?" prompt for a tab close, a reload, or a link out of the
 * application. Browsers ignore any custom message here and show their own wording, which is why
 * the in-application prompt is handled in C# with a real dialog instead.
 */
const armed = new Map();

export function arm(id) {
    if (armed.has(id)) {
        return;
    }
    const handler = event => {
        event.preventDefault();
        // Older browsers need returnValue set to show the prompt at all.
        event.returnValue = '';
        return '';
    };
    window.addEventListener('beforeunload', handler);
    armed.set(id, handler);
}

export function disarm(id) {
    const handler = armed.get(id);
    if (!handler) {
        return;
    }
    window.removeEventListener('beforeunload', handler);
    armed.delete(id);
}
