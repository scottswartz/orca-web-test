// Tab reordering by pointer drag.
//
// Listeners live on the wrapper, not on each tab, because Blazor patches and replaces the tab
// buttons whenever the list re-renders — per-tab listeners would be lost on the first reorder,
// which is exactly when they are needed again.
//
// Ctrl with an arrow key is handled in C#, where the writing direction is — but it comes back
// here through locate() for the position, because the DOM is the only place the order is right.

const states = new Map();

/**
 * Starts drag reordering for one tabs list.
 * @param {HTMLElement} root - The wrapper holding the tablist.
 * @param {object} dotNetRef - The Blazor component reference.
 * @param {string} id - Unique identifier for this list.
 */
export function initialize(root, dotNetRef, id) {
  if (!root || !dotNetRef || states.has(id)) return;

  const state = { root, dotNetRef, dragValue: null, indicator: null };
  states.set(id, state);

  const tabs = () => Array.from(root.querySelectorAll('[role="tab"][data-tab-value]'));

  const indexOf = (value) => tabs().findIndex((t) => t.getAttribute('data-tab-value') === value);

  // A 2px bar between two tabs. Absolutely positioned against the wrapper, which is already
  // position:relative only while a drag is live — set here rather than in the stylesheet so a
  // list that is never dragged keeps the layout it had.
  const showIndicator = (tab, after) => {
    if (!state.indicator) {
      const bar = document.createElement('div');
      bar.style.cssText =
        'position:absolute;width:2px;top:4px;bottom:4px;pointer-events:none;' +
        'background:currentColor;opacity:0.7;border-radius:1px;';
      root.style.position = 'relative';
      root.appendChild(bar);
      state.indicator = bar;
    }

    const tabRect = tab.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const edge = after ? tabRect.right : tabRect.left;

    state.indicator.style.left = `${edge - rootRect.left}px`;
    state.indicator.style.display = 'block';
  };

  const hideIndicator = () => {
    if (state.indicator) state.indicator.style.display = 'none';
  };

  state.onDragStart = (e) => {
    const tab = e.target.closest('[role="tab"][data-tab-value]');
    if (!tab || !root.contains(tab)) return;

    state.dragValue = tab.getAttribute('data-tab-value');

    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      // Firefox will not start a drag at all without data on the transfer.
      e.dataTransfer.setData('text/plain', state.dragValue);
    }
  };

  state.onDragOver = (e) => {
    if (state.dragValue === null) return;

    const tab = e.target.closest('[role="tab"][data-tab-value]');
    if (!tab) return;

    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    // Past the midpoint means the drop lands after this tab. Measured against the pointer rather
    // than against the dragged element, which in a fallback drag image is not where the cursor is.
    const rect = tab.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    showIndicator(tab, after);
  };

  state.onDrop = (e) => {
    if (state.dragValue === null) return;

    const tab = e.target.closest('[role="tab"][data-tab-value]');
    if (!tab) return;

    e.preventDefault();

    const value = state.dragValue;
    const from = indexOf(value);
    const overIndex = tabs().indexOf(tab);
    const rect = tab.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;

    // Insertion point first, then the final index. Removing the tab before re-inserting shifts
    // every later position down by one, which is the off-by-one this line exists to avoid.
    let target = after ? overIndex + 1 : overIndex;
    if (from < target) target -= 1;

    finish();

    if (from >= 0 && target >= 0 && target !== from) {
      dotNetRef.invokeMethodAsync('OnTabDropped', value, from, target);
    }
  };

  const finish = () => {
    state.dragValue = null;
    hideIndicator();
  };

  state.onDragEnd = finish;
  // A drag that leaves the list entirely should drop the indicator too, or it is left behind
  // pointing at a position the reader has already abandoned.
  state.onDragLeave = (e) => {
    if (!root.contains(e.relatedTarget)) hideIndicator();
  };

  root.addEventListener('dragstart', state.onDragStart);
  root.addEventListener('dragover', state.onDragOver);
  root.addEventListener('drop', state.onDrop);
  root.addEventListener('dragend', state.onDragEnd);
  root.addEventListener('dragleave', state.onDragLeave);
}

/**
 * Reports where a tab currently sits and how many there are.
 *
 * The DOM is the only honest source for this. Blazor moves keyed components on a reorder without
 * changing any parameter, so no child lifecycle runs and any order held in C# from registration
 * time is stale from the first move onwards.
 *
 * @param {string} id - The identifier passed to initialize.
 * @param {string} value - The tab's value.
 * @returns {{index: number, count: number}} -1 for the index when the tab is not found.
 */
export function locate(id, value) {
  const state = states.get(id);
  if (!state) return { index: -1, count: 0 };

  const tabs = Array.from(state.root.querySelectorAll('[role="tab"][data-tab-value]'));
  return {
    index: tabs.findIndex((t) => t.getAttribute('data-tab-value') === value),
    count: tabs.length,
  };
}

/**
 * Selects the whole of a text box, used when an in-place rename opens.
 * @param {HTMLInputElement} input - The rename box.
 */
export function selectAll(input) {
  if (input && typeof input.select === 'function') {
    input.select();
  }
}

/**
 * Stops drag reordering and removes every listener.
 * @param {string} id - The identifier passed to initialize.
 */
export function dispose(id) {
  const state = states.get(id);
  if (!state) return;

  const { root } = state;
  root.removeEventListener('dragstart', state.onDragStart);
  root.removeEventListener('dragover', state.onDragOver);
  root.removeEventListener('drop', state.onDrop);
  root.removeEventListener('dragend', state.onDragEnd);
  root.removeEventListener('dragleave', state.onDragLeave);

  if (state.indicator && state.indicator.parentNode) {
    state.indicator.remove();
  }

  states.delete(id);
}
