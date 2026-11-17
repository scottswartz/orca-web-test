// Phone tool pages: number fields use the on-screen keypad (MobileKeypadHost) instead of the phone keyboard.
// A field picks its keypad with data-keypad="dec|hex|decfx|hexfx"; other number fields get "dec".
window.orcaKeypad = (() => {
    const NUMBER_FIELDS = "input[data-keypad], textarea[data-keypad], input.e-numerictextbox, input[inputmode=decimal], input[inputmode=numeric]";
    let host = null;
    let field = null;
    let edited = false;
    let hideTimer = 0;

    // Returns the keypad mode, and turns the phone keyboard off for that field
    function prepare(el) {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || el.disabled || el.readOnly
            || !el.closest(".orca-mobile") || !el.matches(NUMBER_FIELDS))
            return null;
        // Kept on the field, as inputmode=decimal is gone once it is "none"
        el.dataset.keypad ||= "dec";
        el.inputMode = "none";
        return el.dataset.keypad;
    }

    function onMouseDown(e) {
        // A tap on a key must not take the focus (and the cursor) from the field
        if (e.target.closest?.(".orca-keypad-dock"))
            e.preventDefault();
    }

    // Before focus, so the phone keyboard never opens
    function onPointerDown(e) {
        // A tap on a label's text focuses its field too
        prepare(e.target.closest?.("label")?.control ?? e.target);
    }

    function onFocusIn(e) {
        const mode = prepare(e.target);
        if (!mode)
            return;
        clearTimeout(hideTimer);
        if (field !== e.target)
            edited = false;
        field = e.target;
        host?.invokeMethodAsync("Show", mode);
    }

    function onFocusOut(e) {
        if (e.target !== field)
            return;
        if (e.relatedTarget?.closest?.(".orca-keypad-dock")) {
            field.focus({ preventScroll: true });
            return;
        }
        // Values set from script never fire change, and some fields only save on change
        if (edited)
            field.dispatchEvent(new Event("change", { bubbles: true }));
        field = null;
        // Short wait, so going straight to the next number field doesn't flash the keypad
        hideTimer = setTimeout(() => {
            document.documentElement.style.removeProperty("--orca-keypad-height");
            host?.invokeMethodAsync("Hide");
        }, 50);
    }

    function write(value, caret) {
        field.value = value;
        field.setSelectionRange(caret, caret);
        edited = true;
        field.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function selection() {
        const start = field.selectionStart ?? field.value.length;
        return [start, field.selectionEnd ?? start];
    }

    return {
        attach(dotNet) {
            host = dotNet;
            document.addEventListener("mousedown", onMouseDown, true);
            document.addEventListener("pointerdown", onPointerDown, true);
            document.addEventListener("focusin", onFocusIn);
            document.addEventListener("focusout", onFocusOut);
        },
        detach() {
            host = null;
            field = null;
            clearTimeout(hideTimer);
            document.removeEventListener("mousedown", onMouseDown, true);
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("focusin", onFocusIn);
            document.removeEventListener("focusout", onFocusOut);
            document.documentElement.style.removeProperty("--orca-keypad-height");
        },
        // The page pads its bottom by this much, so the field is never under the keypad
        shown(dock) {
            document.documentElement.style.setProperty("--orca-keypad-height", dock.offsetHeight + "px");
            field?.scrollIntoView({ block: "nearest" });
        },
        type(text) {
            if (!field)
                return;
            const [start, end] = selection();
            write(field.value.slice(0, start) + text + field.value.slice(end), start + text.length);
        },
        backspace() {
            if (!field)
                return;
            let [start, end] = selection();
            if (start === end) {
                if (start === 0)
                    return;
                start--;
            }
            write(field.value.slice(0, start) + field.value.slice(end), start);
        },
        clear() {
            if (field?.value)
                write("", 0);
        },
        // Leaving the field hides the keypad and saves the value, as a tap elsewhere would
        hide() {
            field?.blur();
        }
    };
})();
