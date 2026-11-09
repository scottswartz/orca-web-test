window.orcaLayout = {
    // Puts the sticky nav bar's height in --orca-nav-height on the page, kept up to date (window resized,
    // narrow menu opened), so a page's own sticky parts sit just below the nav instead of under it
    trackNavHeight: function (nav) {
        if (!nav || window.orcaLayout.navObserver) {
            return;
        }

        var update = function () {
            document.documentElement.style.setProperty('--orca-nav-height', nav.offsetHeight + 'px');
        };
        window.orcaLayout.navObserver = new ResizeObserver(update);
        window.orcaLayout.navObserver.observe(nav);
        update();
    }
};
