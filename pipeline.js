const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { mdToPdf } = require('md-to-pdf');
const { runClaude, extractJson } = require('./agents/runClaude');
const { finderPrompt, extractPrompt } = require('./agents/prompts');
const { findImage } = require('./agents/openverse');
const { watermarkImage } = require('./agents/watermark');
const sharp = require('sharp');

const SOURCES_DIR = path.join(__dirname, 'sources');
const RECIPES_DIR = path.join(__dirname, 'recipes');
const IMAGES_DIR = path.join(RECIPES_DIR, 'images');
const CHANNEL_NAME = 'Понятная еда';

function slugify(text) {
  return String(text).replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 50);
}

// Скачивает найденное (уже лицензионно чистое) фото и накладывает водяной знак
// с названием канала. Если скачать/обработать не получилось — публикация не
// срывается, просто используется оригинальная ссылка без знака.
async function watermarkAndSave(image, slug) {
  try {
    const res = await fetch(image.url);
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    const watermarked = await watermarkImage(buffer, CHANNEL_NAME);
    const dims = await sharp(watermarked).metadata();

    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    const localFile = `${slug}.jpg`;
    fs.writeFileSync(path.join(IMAGES_DIR, localFile), watermarked);

    return { localFile, width: dims.width, height: dims.height };
  } catch (e) {
    return null;
  }
}

function imageMarkdownSrc(image) {
  if (image.localFile) {
    return pathToFileURL(path.join(IMAGES_DIR, image.localFile)).href;
  }
  return image.url;
}

function renderTipMarkdown(tip, image, sourceMeta) {
  const lines = [`# ${tip.title}`, ''];

  const authorPart = sourceMeta.author ? `, автор: ${sourceMeta.author}` : '';
  lines.push(`Источник: [${sourceMeta.url}](${sourceMeta.url})${authorPart}.`, '');

  if (image) {
    lines.push(`![${tip.title}](${imageMarkdownSrc(image)})`, '');
    const lic = `${image.license.toUpperCase()}${image.licenseVersion ? ' ' + image.licenseVersion : ''}`;
    lines.push(`*Фото: ${image.creator} — ${lic}*`, '');
  }

  lines.push(tip.body);

  if (image) {
    lines.push('', '---');
    const lic = `${image.license.toUpperCase()}${image.licenseVersion ? ' ' + image.licenseVersion : ''}`;
    const landing = image.foreignLandingUrl || image.url;
    lines.push(`Фото: [${landing}](${landing}), автор ${image.creator}, ${lic}.`);
  }

  return lines.join('\n');
}

// Прогоняет пайплайн (finder → extract → image-picker → pdf-export) для
// категории рецептов. onProgress({ stage, status, ... }) вызывается на границах
// шагов — по одному кандидату за раз, без параллелизма, чтобы не перегружать
// `claude` CLI и не усложнять логику.
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

    try {
      // 2. extract — только факт (сам совет, автор), без пересказа и без
      // вступления от себя. Лицензия источника тут не нужна: практический
      // приём/факт сам по себе не является объектом авторского права.
      onProgress({ stage: 'extract', status: 'running', item: candidate.title });
      const extractText = await runClaude(extractPrompt(candidate.url), {
        label: 'extract',
        allowedTools: ['WebFetch'],
      });
      const extracted = extractJson(extractText);
      onProgress({ stage: 'extract', status: 'done', item: candidate.title });

      const sourceMeta = { url: candidate.url, author: extracted.author || null };

      const sourceSlug = slugify(extracted.title || candidate.title);
      fs.writeFileSync(
        path.join(SOURCES_DIR, `${sourceSlug}.json`),
        JSON.stringify({ ...extracted, ...sourceMeta }, null, 2),
        'utf-8'
      );

      // 3. image-picker (обычный код, без LLM). Фото обязательно — без него
      // совет не публикуется.
      onProgress({ stage: 'image', status: 'running', item: candidate.title });
      const image = await findImage(extracted.imageQuery || extracted.title || candidate.title);
      if (!image) {
        onProgress({ stage: 'image', status: 'rejected', item: candidate.title, reason: 'фото не найдено' });
        rejected.push({ title: candidate.title, url: candidate.url, reason: 'не найдено фото для публикации' });
        continue;
      }
      const tipSlug = slugify(extracted.title || candidate.title);
      const watermarked = await watermarkAndSave(image, tipSlug);
      const finalImage = watermarked ? { ...image, ...watermarked } : image;
      onProgress({ stage: 'image', status: 'done', item: candidate.title, watermarked: Boolean(watermarked) });

      // 4. pdf-export
      const markdown = renderTipMarkdown(extracted, finalImage, sourceMeta);
      const mdFile = `${tipSlug}.md`;
      fs.writeFileSync(path.join(RECIPES_DIR, mdFile), markdown, 'utf-8');

      let pdfFile = null;
      let pdfError = null;
      try {
        pdfFile = `${tipSlug}.pdf`;
        await mdToPdf({ content: markdown }, { dest: path.join(RECIPES_DIR, pdfFile) });
      } catch (e) {
        pdfFile = null;
        pdfError = e.message;
      }

      onProgress({ stage: 'pdf', status: 'done', item: candidate.title, mdFile, pdfFile, pdfError });

      // Метаданные для сборки сайта/RSS-ленты (buildSite.js). pubDate фиксируется
      // один раз здесь и больше не меняется — иначе при каждой пересборке сайта
      // Дзен будет видеть публикацию как "только что вышедшую". type: 'tip'
      // отличает новый формат от старых рецептов (с ingredients/steps),
      // buildSite.js рендерит их по-разному.
      fs.writeFileSync(
        path.join(RECIPES_DIR, `${tipSlug}.json`),
        JSON.stringify(
          {
            slug: tipSlug,
            type: 'tip',
            title: extracted.title,
            body: extracted.body,
            image: finalImage,
            sourceMeta,
            category,
            pubDate: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf-8'
      );

      published.push({ title: extracted.title, mdFile, pdfFile, hasImage: !!image });
    } catch (e) {
      onProgress({ stage: 'candidate', status: 'error', item: candidate.title, message: e.message });
      rejected.push({ title: candidate.title, url: candidate.url, reason: `техническая ошибка: ${e.message}` });
    }
  }

  const summary = { requested: wantCount, published: published.length, publishedItems: published, rejected };
  onProgress({ stage: 'summary', status: 'done', ...summary });
  return summary;
}

module.exports = { runPipeline, SOURCES_DIR, RECIPES_DIR, IMAGES_DIR, CHANNEL_NAME };
