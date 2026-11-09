// Issue reporting's browser side (see IssueReporter): catches JavaScript errors for the issue log, and tells
// .NET what only the browser knows (user agent, window size). Loaded before Blazor starts, so errors that
// happen early are kept until .NET listens.
window.orcaIssues = (function () {
    // Enough to show what went wrong before .NET was ready, without growing if an error loops
    const MAX_PENDING = 20;

    const pending = [];
    let listener = null;

    function send(message, stack) {
        if (!listener) {
            if (pending.length < MAX_PENDING) pending.push([message, stack]);
            return;
        }
        // Reporting must never cause another error report
        listener.invokeMethodAsync('OnJsError', message, stack).catch(function () { });
    }

    // Browser warnings, not bugs: a layout (e.g. a grid resizing to fit) took more than one frame to settle
    const IGNORED = [
        'ResizeObserver loop completed with undelivered notifications',
        'ResizeObserver loop limit exceeded'
    ];

    window.addEventListener('error', function (e) {
        const message = String(e.message || '');
        if (IGNORED.some(function (text) { return message.indexOf(text) >= 0; })) return;

        const stack = e.error && e.error.stack ? e.error.stack : (e.filename || '') + ':' + (e.lineno || 0);
        send(String(e.message || 'Script error'), stack);
    });

    window.addEventListener('unhandledrejection', function (e) {
        const reason = e.reason;
        send(String(reason && reason.message ? reason.message : reason), reason && reason.stack ? reason.stack : '');
    });

    return {
        // dotnetRef: the IssueBrowserBridge that reports to IssueReporter
        listen: function (dotnetRef) {
            listener = dotnetRef;
            pending.splice(0).forEach(function (p) { send(p[0], p[1]); });
        },

        stop: function () {
            listener = null;
        },

        getUserAgent: function () {
            return navigator.userAgent;
        },

        // CSS pixels, e.g. "1280x720"
        getScreen: function () {
            return window.innerWidth + 'x' + window.innerHeight;
        },

        // Dev test page only: a JavaScript error outside any .NET call, like a real script bug
        throwTest: function () {
            setTimeout(function () { throw new Error('Orca test error from JavaScript'); }, 0);
        }
    };
})();
