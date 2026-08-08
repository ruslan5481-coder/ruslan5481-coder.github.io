// Поиск лицензионно чистого фото блюда — не с сайта-источника рецепта, а отдельно
// через Openverse API. license=cc0,pdm,by,by-sa исключает NC (некоммерческое) и
// ND (без производных) — то есть берём только то, что точно можно публиковать
// и (при необходимости) кадрировать/вставлять в свой макет.
async function searchOnce(query) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license=cc0,pdm,by,by-sa&page_size=5`;

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json();
  const best = data.results && data.results[0];
  if (!best) return null;

  return {
    url: best.url,
    creator: best.creator || 'неизвестен',
    creatorUrl: best.creator_url || null,
    license: best.license,
    licenseVersion: best.license_version,
    licenseUrl: best.license_url,
    foreignLandingUrl: best.foreign_landing_url,
    width: best.width || null,
    height: best.height || null,
  };
}

// Пробует запрос как есть; если пусто (например, слишком специфичная фраза) —
// один раз повторяет с укороченным до первых 1-2 слов запросом.
async function findImage(query) {
  const direct = await searchOnce(query);
  if (direct) return direct;

  const broadened = String(query).trim().split(/\s+/).slice(0, 2).join(' ');
  if (broadened && broadened !== query) {
    return searchOnce(broadened);
  }
  return null;
}

module.exports = { findImage };
