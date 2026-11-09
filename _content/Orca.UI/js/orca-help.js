window.orcaHelp = {
    // "#units" links (table of contents, links inside help text) resolve against <base href>, so Blazor
    // would leave the page; this scrolls to the section inside this topic instead. Links to other topics open in the app.
    // Runs before Blazor's own link handler, which skips clicks that are already handled.
    // linkTarget (Help window): gets the other topic's link (HelpTopicContent.OpenTopicLinkAsync) instead of the page moving
    init: function (article, linkTarget) {
        if (!article || article.dataset.orcaHelpReady) {
            return;
        }
        article.dataset.orcaHelpReady = 'true';

        article.addEventListener('click', function (event) {
            var link = event.target.closest && event.target.closest('a[href^="#"], a[href^="/help/"], a[href^="help/"]');
            if (!link || !article.contains(link)) {
                return;
            }

            var href = link.getAttribute('href');
            // "See also" (help/...) is an app link already; Blazor opens it, unless the window takes it
            if (href.charAt(0) === 'h' && !linkTarget) {
                return;
            }
            event.preventDefault();
            window.orcaHelp.hidePreview();

            // Another topic ("/help/can-signal#units"): opened in the app. The leading "/" would skip <base href>,
            // so on the web app (served from a sub-folder) it would leave Orca
            if (href.charAt(0) !== '#') {
                var path = href.charAt(0) === '/' ? href.substring(1) : href;
                if (linkTarget) {
                    linkTarget.invokeMethodAsync('OpenTopicLinkAsync', path);
                } else {
                    window.Blazor.navigateTo(path);
                }
                return;
            }

            window.orcaHelp.showSection(article, href.substring(1));
        });

        window.orcaHelp.listenForPreviews(article);
        window.orcaHelp.listenForReading();
    },

    // Hover (after a short pause) or keyboard focus on a link to another topic shows a preview card: folder, title,
    // first lines and status. The data comes from HelpTopicContent (data-help-previews on the article), so it's
    // read fresh each time and follows the topic shown
    listenForPreviews: function (article) {
        var timer = null;
        var current = null;

        var linkFrom = function (target) {
            var link = target && target.closest && target.closest('a[href^="/help/"]');
            return link && article.contains(link) ? link : null;
        };
        var leave = function () {
            clearTimeout(timer);
            current = null;
            window.orcaHelp.hidePreview();
        };

        article.addEventListener('mouseover', function (event) {
            var link = linkFrom(event.target);
            if (!link || link === current) {
                return;
            }
            current = link;
            clearTimeout(timer);
            timer = setTimeout(function () { window.orcaHelp.showPreview(article, link); }, 300);
        });
        article.addEventListener('mouseout', function (event) {
            var link = linkFrom(event.target);
            if (link && !link.contains(event.relatedTarget)) {
                leave();
            }
        });
        article.addEventListener('focusin', function (event) {
            var link = linkFrom(event.target);
            if (link) {
                current = link;
                window.orcaHelp.showPreview(article, link);
            }
        });
        article.addEventListener('focusout', leave);
        article.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                leave();
            }
        });
    },

    // One card for the app, on the page body so it floats over everything (styles: orca-help.css).
    // Built with textContent only: the data is topic text, never HTML
    showPreview: function (article, link) {
        var match = /^\/help\/([a-z0-9-]+)(?:#([a-z0-9-]+))?$/.exec(link.getAttribute('href') || '');
        var previews;
        try {
            previews = JSON.parse(article.getAttribute('data-help-previews') || '{}');
        } catch (e) {
            return;
        }
        var topic = match && previews[match[1]];
        if (!topic) {
            return;
        }

        var card = window.orcaHelp.previewCard;
        if (!card) {
            card = document.createElement('div');
            card.className = 'orca-help-preview';
            card.id = 'orca-help-preview';
            card.setAttribute('role', 'tooltip');
            document.body.appendChild(card);
            window.orcaHelp.previewCard = card;
        }

        var add = function (parent, className, text) {
            var part = document.createElement('span');
            part.className = className;
            if (text) {
                part.textContent = text;
            }
            parent.appendChild(part);
            return part;
        };

        card.textContent = '';
        if (topic.folder) {
            add(card, 'orca-help-preview-folder', topic.folder);
        }
        var title = add(card, 'orca-help-preview-title', topic.title);
        var section = match[2] && topic.sections ? topic.sections[match[2]] : null;
        if (section) {
            add(title, 'orca-help-preview-section', ' > ' + section);
        }
        add(card, 'orca-help-preview-text' + (topic.summary ? '' : ' empty'), topic.summary || 'Nothing written yet.');
        var foot = add(card, 'orca-help-preview-foot', null);
        if (topic.status) {
            add(foot, 'orca-help-preview-status', topic.status);
        }
        add(foot, 'orca-help-preview-open', section ? 'Click to open at this section' : 'Click to open');

        // Under the link, kept inside the window; above it when there's no room below
        card.hidden = false;
        var rect = link.getBoundingClientRect();
        var left = Math.max(8, Math.min(rect.left, window.innerWidth - card.offsetWidth - 8));
        var top = rect.bottom + 8;
        if (top + card.offsetHeight > window.innerHeight - 8) {
            top = Math.max(8, rect.top - card.offsetHeight - 8);
        }
        card.style.left = left + 'px';
        card.style.top = top + 'px';
        link.setAttribute('aria-describedby', card.id);
    },

    hidePreview: function () {
        var card = window.orcaHelp.previewCard;
        if (card) {
            card.hidden = true;
        }
    },

    // Keeps each topic's contents list on the section being read. One listener for the app that looks up
    // the topics on screen each time, so nothing is left behind when a topic closes. Capture phase, so it
    // also hears a scrolling drawer, not only the window
    listenForReading: function () {
        if (window.orcaHelp.readingListening) {
            return;
        }
        window.orcaHelp.readingListening = true;

        var queued = false;
        document.addEventListener('scroll', function () {
            // A preview is placed for where its link was; scrolling would leave it floating elsewhere
            window.orcaHelp.hidePreview();
            if (queued) {
                return;
            }
            queued = true;
            window.requestAnimationFrame(function () {
                queued = false;
                document.querySelectorAll('.orca-help-content').forEach(window.orcaHelp.markReading);
            });
        }, { capture: true, passive: true });
    },

    // The section being read is the last one whose top has passed the upper third of the window
    // (the last one at the very bottom, however short); its contents link gets aria-current
    markReading: function (article) {
        var links = article && article.querySelectorAll('.orca-help-content-toc a[href^="#"]');
        if (!links || links.length === 0) {
            return;
        }

        var sections = article.querySelectorAll('[data-help-section]');
        var line = window.innerHeight / 3;
        var current = sections[0];
        sections.forEach(function (section) {
            if (section.getBoundingClientRect().top <= line) {
                current = section;
            }
        });
        if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
            current = sections[sections.length - 1];
        }

        var href = current ? '#' + current.getAttribute('data-help-section') : null;
        links.forEach(function (link) {
            if (link.getAttribute('href') === href) {
                link.setAttribute('aria-current', 'location');
            } else {
                link.removeAttribute('aria-current');
            }
        });
    },

    // F1 anywhere opens help for the page (NavMenu.OnHelpKeyAsync). One listener for the app; a later call
    // only swaps the .NET object it calls. Capture phase, so an editor or grid can't swallow the key first.
    listenForF1: function (dotNetRef) {
        window.orcaHelp.f1Target = dotNetRef;
        if (window.orcaHelp.f1Listening) {
            return;
        }
        window.orcaHelp.f1Listening = true;

        document.addEventListener('keydown', function (event) {
            var target = window.orcaHelp.f1Target;
            if (event.key !== 'F1' || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || !target) {
                return;
            }

            // Stops the browser opening its own help page
            event.preventDefault();
            target.invokeMethodAsync('OnHelpKeyAsync');
        }, true);
    },

    stopListeningForF1: function () {
        window.orcaHelp.f1Target = null;
    },

    // Also used to open a section from outside (e.g. /help/can-signal#units, or a validation error later)
    showSection: function (article, sectionId) {
        var section = article && article.querySelector('[data-help-section="' + CSS.escape(sectionId) + '"]');
        if (!section) {
            return;
        }

        section.scrollIntoView({ block: 'start' });
        section.focus({ preventScroll: true });
    }
};
