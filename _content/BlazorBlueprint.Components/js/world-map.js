// Country boundaries are fetched only when a map series is used, once per page.
const mapName = 'bb-world';
let loadPromise;
let countries;
let aspectRatio;

export async function ensureWorldMap(echarts, option) {
  if (!option.series?.some(series => series.type === 'map' && series.map === mapName)) return;

  if (!loadPromise) {
    loadPromise = (async () => {
      const response = await fetch(new URL('../maps/world.json', import.meta.url));
      if (!response.ok) throw new Error(`Unable to load world map: ${response.status}`);
      const geoJson = await response.json();
      countries = new Map();
      const bounds = [Infinity, Infinity, -Infinity, -Infinity];
      const extendBounds = coordinates => {
        if (typeof coordinates[0] === 'number') {
          bounds[0] = Math.min(bounds[0], coordinates[0]);
          bounds[1] = Math.min(bounds[1], coordinates[1]);
          bounds[2] = Math.max(bounds[2], coordinates[0]);
          bounds[3] = Math.max(bounds[3], coordinates[1]);
        } else {
          coordinates.forEach(extendBounds);
        }
      };
      for (const feature of geoJson.features) {
        extendBounds(feature.geometry.coordinates);
        const { name, aliases } = feature.properties;
        for (const alias of [name, ...aliases]) {
          countries.set(alias.trim().toLowerCase(), name);
        }
      }
      // ECharts' default geographic aspect scale is 0.75.
      aspectRatio = (bounds[2] - bounds[0]) / (bounds[3] - bounds[1]) * 0.75;
      return geoJson;
    })().catch(error => {
      loadPromise = null; // A failed request must not poison future map instances.
      throw error;
    });
  }

  const geoJson = await loadPromise;
  if (!echarts.getMap(mapName)) echarts.registerMap(mapName, geoJson);
}

// Runs before theme resolution, leaving the raw option untouched for later updates.
export function prepareWorldMap(option, element) {
  const mapSeries = option.series?.filter(series => series.type === 'map' && series.map === mapName);
  if (!mapSeries?.length || !countries) return option;

  const prepared = structuredClone(option);
  const values = [];
  const seriesIndices = [];
  prepared.series.forEach((series, index) => {
    if (series.type !== 'map' || series.map !== mapName) return;
    seriesIndices.push(index);
    const seen = new Set();
    series.data = (series.data ?? []).flatMap(item => {
      const name = countries.get(item.name?.trim().toLowerCase());
      if (!name || seen.has(name)) return [];
      seen.add(name);
      if (Number.isFinite(item.value)) values.push(item.value);
      return [{ ...item, name }];
    });
    // Set missing regions explicitly so visualMap cannot mistake them for zero.
    const present = new Set(series.data.filter(item => Number.isFinite(item.value)).map(item => item.name));
    for (const name of new Set(countries.values())) {
      if (present.has(name)) continue;
      const existing = series.data.find(item => item.name === name);
      const item = existing ?? { name, value: null, bbSourceIndex: -1 };
      item.itemStyle = { areaColor: series.itemStyle?.areaColor };
      if (!existing) series.data.push(item);
    }
    series.scaleLimit = { min: 1, max: 20 };
    if (element) Object.assign(series, mapLayout(element));
  });

  if (!prepared.visualMap) {
    const min = values.length ? Math.min(0, ...values) : 0;
    const max = values.length ? Math.max(0, ...values) : 1;
    prepared.visualMap = {
      type: 'continuous', min, max: max > min ? max : min + 1,
      seriesIndex: seriesIndices, orient: 'horizontal', left: 'center', bottom: 0,
      inRange: { color: ['var(--background)', 'var(--chart-1)'] },
      textStyle: { color: 'var(--muted-foreground)' }
    };
  }
  prepared.visualMap.text ??= [String(prepared.visualMap.max), String(prepared.visualMap.min)];
  prepared.visualMap.textStyle ??= { color: 'var(--muted-foreground)' };
  return prepared;
}

function mapLayout(element) {
  const top = 30;
  const bottom = 55;
  const height = Math.max(1, element.clientHeight - top - bottom);
  return {
    layoutCenter: ['50%', top + height / 2],
    layoutSize: Math.max(1, Math.min(element.clientWidth, height * aspectRatio))
  };
}

// Update layout alone on resize, preserving the current pan/zoom and color range selection.
export function resizeWorldMap(chart, option, element) {
  if (!aspectRatio || !option.series?.some(series => series.map === mapName)) return;
  chart.setOption({
    series: option.series.map(series => series.map === mapName ? mapLayout(element) : {})
  });
}
