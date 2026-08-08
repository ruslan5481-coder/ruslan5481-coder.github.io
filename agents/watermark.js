// Накладывает на фото полупрозрачную подпись с названием канала. Само фото уже
// лицензионно чистое (Openverse) — водяной знак не меняет это, автор всё равно
// указывается отдельно в подписи под фото.
const sharp = require('sharp');

async function watermarkImage(buffer, text) {
  const base = sharp(buffer).rotate();
  const meta = await base.metadata();
  const width = meta.width || 1024;
  const height = meta.height || 768;

  const fontSize = Math.max(18, Math.round(width * 0.035));
  const paddingX = Math.round(width * 0.025);
  const paddingY = Math.round(height * 0.03);
  const strokeWidth = Math.max(1, Math.round(fontSize * 0.08));
  const escaped = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
<text x="${width - paddingX}" y="${height - paddingY}" text-anchor="end"
  font-family="Georgia, 'Segoe UI', Arial, sans-serif" font-size="${fontSize}" font-weight="700"
  fill="#ffffff" fill-opacity="0.88" stroke="#000000" stroke-opacity="0.4"
  stroke-width="${strokeWidth}" paint-order="stroke">${escaped}</text>
</svg>`;

  return base
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

module.exports = { watermarkImage };
