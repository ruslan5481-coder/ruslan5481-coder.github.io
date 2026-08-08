const fs = require('fs');
const path = require('path');
const { mdToPdf } = require('md-to-pdf');
const { runClaude, extractJson } = require('./agents/runClaude');
const { finderPrompt, fetchAndVerifyPrompt, writerPrompt } = require('./agents/prompts');
const { findImage } = require('./agents/openverse');

const SOURCES_DIR = path.join(__dirname, 'sources');
const RECIPES_DIR = path.join(__dirname, 'recipes');

// Источники с заведомо известной открытой лицензией — для них проверка лицензии
// на странице не нужна. Список легко расширяется.
const TRUSTED_DOMAINS = ['ru.wikibooks.org'];

function slugify(text) {
  return String(text).replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 50);
}

function isTrusted(url) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return TRUSTED_DOMAINS.includes(hostname);
  } catch (e) {
    return false;
  }
}

function renderRecipeMarkdown(recipe, image, sourceMeta) {
  const lines = [`# ${recipe.title}`, ''];

  if (image) {
    lines.push(`![${recipe.title}](${image.url})`, '');
    const lic = `${image.license.toUpperCase()}${image.licenseVersion ? ' ' + image.licenseVersion : ''}`;
    lines.push(`*Фото: ${image.creator} — ${lic}*`, '');
  }

  lines.push(recipe.intro, '');
  lines.push('## Ингредиенты');
  recipe.ingredients.forEach((i) => lines.push(`- ${i}`));
  lines.push('');
  lines.push('## Приготовление');
  recipe.steps.forEach((s, idx) => lines.push(`${idx + 1}. ${s}`));
  lines.push('', '---');
  lines.push(`Текст адаптирован по материалам: [${sourceMeta.url}](${sourceMeta.url}) (${sourceMeta.license}).`);
  if (image) {
    const lic = `${image.license.toUpperCase()}${image.licenseVersion ? ' ' + image.licenseVersion : ''}`;
    const landing = image.foreignLandingUrl || image.url;
    lines.push(`Фото: [${landing}](${landing}), автор ${image.creator}, ${lic}.`);
  }

  return lines.join('\n');
}

// Прогоняет пайплайн (finder → [trusted-check →] fetch-and-verify → writer →
// image-picker → pdf-export) для категории рецептов. onProgress({ stage, status,
// ... }) вызывается на границах шагов — по одному кандидату за раз, без
// параллелизма, чтобы не перегружать `claude` CLI и не усложнять логику.
async function runPipeline(category, count, { onProgress = () => {} } = {}) {
  if (!category || !category.trim()) {
    throw new Error('Категория не указана.');
  }
  const wantCount = count && count > 0 ? count : 5;

  fs.mkdirSync(SOURCES_DIR, { recursive: true });
  fs.mkdirSync(RECIPES_DIR, { recursive: true });

  // 1. finder
  onProgress({ stage: 'finder', status: 'running' });
  const finderText = await runClaude(finderPrompt(category, wantCount), {
    label: 'finder',
    allowedTools: ['WebSearch'],
  });
  const { candidates } = extractJson(finderText);
  onProgress({ stage: 'finder', status: 'done', candidatesFound: candidates.length });

  const published = [];
  const rejected = [];

  for (const candidate of candidates) {
    if (published.length >= wantCount) break;

    const trusted = isTrusted(candidate.url);

    try {
      // 2. fetch-and-verify (для недоверенных — вердикт по лицензии + рецепт за один вызов)
      onProgress({ stage: 'license-check', status: trusted ? 'skipped' : 'running', item: candidate.title });
      const verifyText = await runClaude(
        fetchAndVerifyPrompt(candidate.url, { requireLicenseCheck: !trusted }),
        { label: 'fetch-and-verify', allowedTools: ['WebFetch'] }
      );
      const verified = extractJson(verifyText);

      if (!trusted && verified.licensed !== true) {
        onProgress({
          stage: 'license-check',
          status: 'rejected',
          item: candidate.title,
          reason: 'не найдена явная пометка об открытой лицензии',
        });
        rejected.push({ title: candidate.title, url: candidate.url, reason: 'лицензия не подтверждена' });
        continue;
      }
      onProgress({
        stage: 'license-check',
        status: trusted ? 'skipped' : 'done',
        item: candidate.title,
        license: trusted ? 'доверенный источник' : verified.license,
      });

      const sourceMeta = {
        url: candidate.url,
        author: verified.author || null,
        license: trusted ? 'доверенный источник (ru.wikibooks.org и т.п.)' : verified.license,
        evidence: verified.evidence || null,
      };

      const sourceSlug = slugify(verified.title || candidate.title);
      fs.writeFileSync(
        path.join(SOURCES_DIR, `${sourceSlug}.json`),
        JSON.stringify({ ...verified, ...sourceMeta }, null, 2),
        'utf-8'
      );
      onProgress({ stage: 'fetcher', status: 'done', item: candidate.title, artifact: `sources/${sourceSlug}.json` });

      // 3. writer
      onProgress({ stage: 'writer', status: 'running', item: candidate.title });
      const writerText = await runClaude(writerPrompt(verified), { label: 'writer' });
      const rewritten = extractJson(writerText);
      onProgress({ stage: 'writer', status: 'done', item: candidate.title });

      // 4. image-picker (обычный код, без LLM). Фото обязательно — без него
      // рецепт не публикуется, как и при непройденной проверке лицензии.
      onProgress({ stage: 'image', status: 'running', item: candidate.title });
      const image = await findImage(rewritten.imageQuery || rewritten.title || candidate.title);
      if (!image) {
        onProgress({ stage: 'image', status: 'rejected', item: candidate.title, reason: 'фото не найдено' });
        rejected.push({ title: candidate.title, url: candidate.url, reason: 'не найдено фото для публикации' });
        continue;
      }
      onProgress({ stage: 'image', status: 'done', item: candidate.title });

      // 5. pdf-export
      const markdown = renderRecipeMarkdown(rewritten, image, sourceMeta);
      const recipeSlug = slugify(rewritten.title || candidate.title);
      const mdFile = `${recipeSlug}.md`;
      fs.writeFileSync(path.join(RECIPES_DIR, mdFile), markdown, 'utf-8');

      let pdfFile = null;
      let pdfError = null;
      try {
        pdfFile = `${recipeSlug}.pdf`;
        await mdToPdf({ content: markdown }, { dest: path.join(RECIPES_DIR, pdfFile) });
      } catch (e) {
        pdfFile = null;
        pdfError = e.message;
      }

      onProgress({ stage: 'pdf', status: 'done', item: candidate.title, mdFile, pdfFile, pdfError });

      // Метаданные для сборки сайта/RSS-ленты (buildSite.js). pubDate фиксируется
      // один раз здесь и больше не меняется — иначе при каждой пересборке сайта
      // Дзен будет видеть рецепт как "только что опубликованный".
      fs.writeFileSync(
        path.join(RECIPES_DIR, `${recipeSlug}.json`),
        JSON.stringify(
          {
            slug: recipeSlug,
            title: rewritten.title,
            intro: rewritten.intro,
            ingredients: rewritten.ingredients,
            steps: rewritten.steps,
            image,
            sourceMeta,
            category,
            pubDate: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf-8'
      );

      published.push({ title: rewritten.title, mdFile, pdfFile, hasImage: !!image });
    } catch (e) {
      onProgress({ stage: 'candidate', status: 'error', item: candidate.title, message: e.message });
      rejected.push({ title: candidate.title, url: candidate.url, reason: `техническая ошибка: ${e.message}` });
    }
  }

  const summary = { requested: wantCount, published: published.length, publishedItems: published, rejected };
  onProgress({ stage: 'summary', status: 'done', ...summary });
  return summary;
}

module.exports = { runPipeline, SOURCES_DIR, RECIPES_DIR };
