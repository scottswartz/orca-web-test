// One shared tooltip for the whole app - used for validation error badges ("error")
// and help icons like Bit Zero Orientation ("info").
// Any element with data-orca-tooltip="text" gets it:
//   data-orca-tooltip-title   - optional bold heading (e.g. the field name)
//   data-orca-tooltip-variant - "error" or "info" (default)
// It lives in <body>, so grid cells and scroll areas can't clip it, and one listener
// serves every element, so it costs nothing per grid cell.
(function () {
    var OPEN_DELAY_MS = 200;
    var GAP_PX = 8;
    var tip = null;
    var current = null;
    var openTimer = null;

    function getTip() {
        if (!tip) {
            tip = document.createElement('div');
            tip.className = 'orca-tooltip';
            tip.setAttribute('role', 'tooltip');
            document.body.appendChild(tip);
        }
        return tip;
    }

    function render(el) {
        var t = getTip();
        t.textContent = '';
        t.className = 'orca-tooltip orca-tooltip-' + (el.getAttribute('data-orca-tooltip-variant') || 'info');

        // textContent only, never HTML, so a message can't inject markup
        var title = el.getAttribute('data-orca-tooltip-title');
        if (title) {
            var heading = document.createElement('div');
            heading.className = 'orca-tooltip-title';
            heading.textContent = title;
            t.appendChild(heading);
        }
        var body = document.createElement('div');
        body.className = 'orca-tooltip-body';
        body.textContent = el.getAttribute('data-orca-tooltip');
        t.appendChild(body);
    }

    // Above the element, centered; below it if there's no room; kept inside the window.
    function position(el) {
        var t = getTip();
        var target = el.getBoundingClientRect();
        var box = t.getBoundingClientRect();

        var top = target.top - box.height - GAP_PX;
        var placement = 'top';
        if (top < GAP_PX) {
            top = target.bottom + GAP_PX;
            placement = 'bottom';
        }

        var left = target.left + target.width / 2 - box.width / 2;
        left = Math.max(GAP_PX, Math.min(left, window.innerWidth - box.width - GAP_PX));

        t.style.top = top + 'px';
        t.style.left = left + 'px';
        t.setAttribute('data-placement', placement);
        // Keeps the arrow pointing at the element even when the bubble is shifted to fit
        t.style.setProperty('--orca-tooltip-arrow-left', (target.left + target.width / 2 - left) + 'px');
    }

    function show(el) {
        render(el);
        position(el);
        getTip().classList.add('orca-tooltip-visible');
    }

    function hide() {
        clearTimeout(openTimer);
        current = null;
        if (tip) {
            tip.classList.remove('orca-tooltip-visible');
        }
    }

    function targetOf(event) {
        return event.target instanceof Element ? event.target.closest('[data-orca-tooltip]') : null;
    }

    function open(el) {
        if (el === current) {
            return;
        }
        hide();
        if (!el) {
            return;
        }
        current = el;
        openTimer = setTimeout(function () {
            // The element may have been removed (e.g. the error was fixed) while waiting
            if (current === el && document.contains(el)) {
                show(el);
            }
        }, OPEN_DELAY_MS);
    }

    document.addEventListener('mouseover', function (e) { open(targetOf(e)); });
    document.addEventListener('focusin', function (e) { open(targetOf(e)); });
    document.addEventListener('focusout', hide);
    // Typing can fix the error and remove its icon, and scrolling moves the element
    document.addEventListener('input', hide, true);
    document.addEventListener('scroll', hide, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { hide(); } });
})();
