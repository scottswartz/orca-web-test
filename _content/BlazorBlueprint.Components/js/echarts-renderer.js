// echarts-renderer.js
// Manages ECharts instance lifecycle: create, update, resize, dispose

import { resolveThemeColors, watchThemeChanges } from './chart-theme.js';
import { ensureWorldMap, prepareWorldMap, resizeWorldMap } from './world-map.js';

/** @type {Map<string, ChartState>} */
const instances = new Map();
const pendingInitializations = new Map();

/** @type {Promise|null} */
let echartsLoadPromise = null;

/** @type {any} */
let echartsLib = null;

/**
 * Lazily load the ECharts ESM library.
 * Uses a single-flight pattern to prevent duplicate loads.
 * @returns {Promise<any>}
 */
async function loadECharts() {
  if (echartsLib) return echartsLib;

  // Check for globally loaded ECharts first (e.g., via <script> tag)
  if (window.echarts) {
    echartsLib = window.echarts;
    return echartsLib;
  }

  if (!echartsLoadPromise) {
    echartsLoadPromise = (async () => {
      // Resolve relative to this module's own URL
      const libPath = new URL('../lib/echarts/echarts.min.js', import.meta.url).href;
      const mod = await import(libPath);
      return mod;
    })();
  }

  echartsLib = await echartsLoadPromise;
  return echartsLib;
}

/**
 * Flattens an ECharts click param into the shape ChartClickEventArgs expects.
 *
 * `value` is whatever the series put there: a number for a bar or line, an array for scatter or
 * candlestick, sometimes an object. Splitting it into a scalar and an array means the common two
 * cases arrive typed on the C# side rather than as a JsonElement the consumer has to unpick, and
 * anything else arrives as nulls with name and dataIndex still identifying the point.
 *
 * @param {object} params - ECharts event params
 * @returns {object} Payload matching ChartClickEventArgs
 */
function toClickArgs(params) {
  const raw = params.value;
  let value = null;
  let values = null;

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    value = raw;
  } else if (Array.isArray(raw)) {
    values = raw.map((v) => (typeof v === 'number' ? v : Number(v))).map((v) => (Number.isFinite(v) ? v : 0));
  }

  return {
    seriesName: params.seriesName ?? null,
    seriesIndex: typeof params.seriesIndex === 'number' ? params.seriesIndex : -1,
    dataIndex: params.seriesType === 'map'
      ? (params.data?.bbSourceIndex ?? -1)
      : (typeof params.dataIndex === 'number' ? params.dataIndex : -1),
    name: params.name ?? null,
    componentType: params.componentType ?? null,
    value,
    values
  };
}

/**
 * Initialize an ECharts instance on a DOM element.
 * @param {string} chartId - Unique chart identifier (matches element id)
 * @param {object} option - ECharts option object (JSON from C#)
 * @param {object} [dotNetRef] - Optional .NET reference for click callbacks (#480). Only passed
 *   when the component actually has a handler, so a chart with none does no interop at all.
 */
export async function initialize(chartId, option, dotNetRef) {
  const element = document.getElementById(chartId);
  if (!element) return;

  // Dispose existing instance if re-initializing
  if (instances.has(chartId)) {
    dispose(chartId);
  }

  const initialization = {};
  pendingInitializations.set(chartId, initialization);
  const echarts = await loadECharts();
  await ensureWorldMap(echarts, option);
  if (pendingInitializations.get(chartId) !== initialization || !element.isConnected) return;
  pendingInitializations.delete(chartId);

  const chart = echarts.init(element, null, { renderer: 'svg' });

  // Resolve CSS variables and set options
  const resolvedOption = resolveThemeColors(prepareWorldMap(option, element), element);
  applyRadarTooltipFormatter(resolvedOption);
  chart.setOption(resolvedOption);

  // ResizeObserver for responsive charts
  const resizeObserver = new ResizeObserver(() => {
    if (!chart.isDisposed()) {
      chart.resize();
      const state = instances.get(chartId);
      if (state) resizeWorldMap(chart, state.lastOption, element);
    }
  });
  resizeObserver.observe(element);

  // Theme change watcher - re-resolve CSS variables on theme change
  const themeUnwatch = watchThemeChanges(() => {
    const state = instances.get(chartId);
    if (state && state.lastOption && !state.chart.isDisposed()) {
      const reresolved = resolveThemeColors(prepareWorldMap(state.lastOption, state.element), state.element);
      applyRadarTooltipFormatter(reresolved);
      state.chart.setOption(reresolved, { notMerge: true });
    }
  });

  instances.set(chartId, {
    chart,
    element,
    resizeObserver,
    themeUnwatch,
    dotNetRef: null,
    lastOption: option
  });
  setClickHandler(chartId, dotNetRef);
}

// Keep subscriptions independent of chart options: callbacks can change without data changes.
export function setClickHandler(chartId, dotNetRef) {
  const state = instances.get(chartId);
  if (!state || state.chart.isDisposed()) return;
  if (state.dataClick) state.chart.off('click', state.dataClick);
  if (state.blankClick) state.chart.getZr().off('click', state.blankClick);
  state.dataClick = state.blankClick = null;
  state.dotNetRef = dotNetRef;
  if (!dotNetRef) return;
  // ECharts reports data points here; zrender also sees blank canvas clicks.
  state.dataClick = params => dotNetRef.invokeMethodAsync('HandleDataPointClick', toClickArgs(params));
  state.blankClick = event => {
    // A target is a rendered shape. containPixel('grid') would also exclude gaps between bars.
    if (!event.target) dotNetRef.invokeMethodAsync('HandleChartClick');
  };
  state.chart.on('click', state.dataClick);
  state.chart.getZr().on('click', state.blankClick);
}

/**
 * Update chart options.
 * @param {string} chartId - Chart identifier
 * @param {object} option - New ECharts option
 * @param {boolean} notMerge - If true, replace entirely (default: true)
 */
export async function update(chartId, option, notMerge) {
  const state = instances.get(chartId);
  if (!state || state.chart.isDisposed()) return;

  state.lastOption = option;
  await ensureWorldMap(echartsLib, option);
  if (state.chart.isDisposed() || state.lastOption !== option) return;
  const resolved = resolveThemeColors(prepareWorldMap(option, state.element), state.element);
  applyRadarTooltipFormatter(resolved);
  state.chart.setOption(resolved, { notMerge: notMerge !== false });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

/**
 * If the chart is a radar with rich-text indicator names (e.g. "{a|186/80}\n{b|January}"),
 * install a tooltip formatter that strips the rich-text tokens and escapes data-derived text.
 * @param {object} option - Resolved ECharts option
 */
function applyRadarTooltipFormatter(option) {
  if (!option.radar?.indicator || !option.tooltip) return;

  const hasRichText = option.radar.indicator.some(
    i => i.name && /\{[a-z]\|/.test(i.name)
  );
  if (!hasRichText) return;

  // Extract clean display names by taking the last rich-text token (e.g. "{b|January}" → "January").
  // Falls back to stripping all tokens if no match.
  const cleanNames = option.radar.indicator.map(i => {
    if (!i.name) return '';
    const matches = [...i.name.matchAll(/\{[a-z]\|([^}]*)\}/g)];
    return matches.length > 0 ? matches[matches.length - 1][1] : i.name;
  });

  option.tooltip.formatter = (params) => {
    let html = `${params.marker} <strong>${escapeHtml(params.seriesName)}</strong>`;
    if (Array.isArray(params.value)) {
      params.value.forEach((val, idx) => {
        if (idx < cleanNames.length) {
          html += `<br/>${escapeHtml(cleanNames[idx])}: ${escapeHtml(val)}`;
        }
      });
    }
    return html;
  };
}

/**
 * Dispose an ECharts instance and clean up all resources.
 * @param {string} chartId - Chart identifier
 */
export function dispose(chartId) {
  pendingInitializations.delete(chartId);
  const state = instances.get(chartId);
  if (!state) return;

  state.resizeObserver.disconnect();
  if (state.themeUnwatch) {
    state.themeUnwatch();
  }
  if (!state.chart.isDisposed()) {
    state.chart.dispose();
  }
  instances.delete(chartId);
}
