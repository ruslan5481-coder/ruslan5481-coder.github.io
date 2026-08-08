// Собирает статический сайт (docs/) из recipes/*.json — HTML-страницы рецептов,
// витрину и RSS-ленту по спецификации Дзена (см. план: RSS 2.0, content:encoded
// с ограниченным набором тегов, enclosure от 480x320px). docs/ публикуется как
// GitHub Pages, ленту дальше подключают в настройках канала Дзена вручную.
const fs = require('fs');
const path = require('path');
const { RECIPES_DIR, IMAGES_DIR } = require('./pipeline');

const DOCS_DIR = path.join(__dirname, 'docs');
const DOCS_IMAGES_DIR = path.join(DOCS_DIR, 'images');
// Репозиторий назван ровно "ruslan5481-coder.github.io" — GitHub публикует такой
// репозиторий в корне домена (без /recipe-finder/ в адресе), это нужно Дзену,
// который принимает в поле "Домен" только чистый хост, без пути.
const SITE_URL = 'https://ruslan5481-coder.github.io';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function licenseLabel(image) {
  return `${String(image.license).toUpperCase()}${image.licenseVersion ? ' ' + image.licenseVersion : ''}`;
}

function imageMeetsMinSize(image) {
  return Boolean(image && image.width && image.height && image.width >= 480 && image.height >= 320);
}

function imageMimeType(url) {
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

// Если фото прошло через водяной знак — оно уже лежит локально в docs/images/
// (см. buildSite ниже), иначе используем оригинальную ссылку на Openverse.
function imageSiteUrl(image) {
  if (!image) return null;
  return image.localFile ? `${SITE_URL}/images/${encodeURIComponent(image.localFile)}` : image.url;
}

// В RSS ≤80 симв., без КАПСА-эмоций/точки в конце/эмодзи — сама HTML-страница
// при этом показывает оригинальный заголовок целиком.
function cleanTitleForDzen(title) {
  let t = String(title).trim().replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
  t = t.replace(/\.+$/g, '');
  if (t.length > 80) t = t.slice(0, 77).trimEnd() + '…';
  return t;
}

function attributionHtml(recipe) {
  const src = recipe.sourceMeta;
  const lines = [`<p>Текст адаптирован по материалам: <a href="${esc(src.url)}">${esc(src.url)}</a> (${esc(src.license)}).</p>`];
  if (recipe.image) {
    const landing = recipe.image.foreignLandingUrl || recipe.image.url;
    lines.push(
      `<p>Фото: <a href="${esc(landing)}">${esc(landing)}</a>, автор ${esc(recipe.image.creator)}, ${esc(licenseLabel(recipe.image))}.</p>`
    );
  }
  return `<blockquote>${lines.join('')}</blockquote>`;
}

// forFeed=true — в RSS картинка идёт только если проходит по минимальному
// размеру Дзена; на обычной странице сайта такого ограничения нет.
function renderRecipeBody(recipe, { forFeed }) {
  const parts = [];
  const showImage = recipe.image && (!forFeed || imageMeetsMinSize(recipe.image));

  if (showImage) {
    parts.push(
      `<figure><img src="${esc(imageSiteUrl(recipe.image))}" alt="${esc(recipe.title)}"><figcaption>Фото: ${esc(recipe.image.creator)} — ${esc(licenseLabel(recipe.image))}</figcaption></figure>`
    );
  }

  parts.push(`<p>${esc(recipe.intro)}</p>`);
  parts.push('<h2>Ингредиенты</h2>');
  parts.push('<ul>' + recipe.ingredients.map((i) => `<li>${esc(i)}</li>`).join('') + '</ul>');
  parts.push('<h2>Приготовление</h2>');
  parts.push('<ol>' + recipe.steps.map((s) => `<li>${esc(s)}</li>`).join('') + '</ol>');
  parts.push(attributionHtml(recipe));

  return parts.join('\n');
}

function renderRecipePage(recipe) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(recipe.title)}</title>
</head>
<body>
<h1>${esc(recipe.title)}</h1>
${renderRecipeBody(recipe, { forFeed: false })}
<p><a href="../index.html">&larr; Все рецепты</a></p>
</body>
</html>
`;
}

// Dzen требует, чтобы <link> состоял из ASCII-символов — слаги у нас кириллические
// (нормальные имена файлов на диске), поэтому в URL их percent-encode'им.
function recipeUrl(recipe) {
  return `${SITE_URL}/recipes/${encodeURIComponent(recipe.slug)}.html`;
}

function renderFeedItem(recipe) {
  const link = recipeUrl(recipe);
  const pubDate = new Date(recipe.pubDate).toUTCString();
  const body = renderRecipeBody(recipe, { forFeed: true });
  const imgUrl = imageSiteUrl(recipe.image);
  const enclosure = imageMeetsMinSize(recipe.image)
    ? `<enclosure url="${esc(imgUrl)}" length="0" type="${imageMimeType(imgUrl)}" />\n`
    : '';

  return `<item>
<title>${esc(cleanTitleForDzen(recipe.title))}</title>
<link>${esc(link)}</link>
<guid isPermaLink="true">${esc(link)}</guid>
<pubDate>${pubDate}</pubDate>
<category>${esc(recipe.category)}</category>
${enclosure}<content:encoded><![CDATA[${body}]]></content:encoded>
</item>`;
}

function renderFeed(recipes) {
  const items = recipes.map(renderFeedItem).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:media="https://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/" version="2.0">
<channel>
<title>Простые рецепты</title>
<link>${SITE_URL}/</link>
<description>Простые рецепты без сложных ингредиентов</description>
<language>ru</language>
${items}
</channel>
</rss>
`;
}

function renderIndex(recipes) {
  const items = recipes
    .map((r) => `<li><a href="recipes/${encodeURIComponent(r.slug)}.html">${esc(r.title)}</a></li>`)
    .join('\n');
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Простые рецепты</title>
</head>
<body>
<h1>Простые рецепты</h1>
<p><a href="feed.xml">RSS-лента</a></p>
<ul>
${items}
</ul>
</body>
</html>
`;
}

function buildSite() {
  const files = fs.existsSync(RECIPES_DIR) ? fs.readdirSync(RECIPES_DIR).filter((f) => f.endsWith('.json')) : [];
  const recipes = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, f), 'utf-8')))
    .sort((a, b) => (a.pubDate < b.pubDate ? 1 : -1));

  fs.mkdirSync(path.join(DOCS_DIR, 'recipes'), { recursive: true });
  fs.mkdirSync(DOCS_IMAGES_DIR, { recursive: true });

  recipes.forEach((r) => {
    fs.writeFileSync(path.join(DOCS_DIR, 'recipes', `${r.slug}.html`), renderRecipePage(r), 'utf-8');
    if (r.image && r.image.localFile) {
      const src = path.join(IMAGES_DIR, r.image.localFile);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(DOCS_IMAGES_DIR, r.image.localFile));
      }
    }
  });

  fs.writeFileSync(path.join(DOCS_DIR, 'feed.xml'), renderFeed(recipes), 'utf-8');
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), renderIndex(recipes), 'utf-8');

  console.log(`Сайт собран: ${recipes.length} рецепт(ов) → docs/`);
}

buildSite();
