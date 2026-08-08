// Поиск лицензионно чистого фото блюда — не с сайта-источника рецепта, а отдельно
// через Openverse API. license=cc0,pdm,by,by-sa исключает NC (некоммерческое) и
// ND (без производных) — то есть берём только то, что точно можно публиковать
// и (при необходимости) кадрировать/вставлять в свой макет.
async function findImage(query) {
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

module.exports = { findImage };
