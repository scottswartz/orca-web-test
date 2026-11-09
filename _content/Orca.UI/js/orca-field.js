window.orcaField = {
    // Puts the cursor in the input next to a validation error, after jumping to it from the
    // validation grid. Works for form fields and grid cells (same container classes as the CSS).
    focus: function (errorElement) {
        var container = errorElement && errorElement.closest('.orca-node-field, .e-rowcell');
        var input = container && container.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
        if (!input) { return; }

        input.scrollIntoView({ block: 'center', inline: 'nearest' });
        input.focus({ preventScroll: true });

        // Brief flash so the eye finds the field; removing first restarts it on a repeat jump
        input.classList.remove('orca-field-flash');
        void input.offsetWidth;
        input.classList.add('orca-field-flash');
        input.addEventListener('animationend', function () { input.classList.remove('orca-field-flash'); }, { once: true });
    }
};
