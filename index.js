const { runPipeline } = require('./pipeline');

function parseArgs(argv) {
  const first = argv[0];
  const asCount = Number.parseInt(first, 10);
  if (argv.length > 1 && Number.isInteger(asCount) && String(asCount) === first) {
    return { count: asCount, category: argv.slice(1).join(' ').trim() };
  }
  return { count: 5, category: argv.join(' ').trim() };
}

function cliProgress(event) {
  const { stage, status, item } = event;

  if (stage === 'finder' && status === 'done') {
    console.log(`  → finder нашёл кандидатов: ${event.candidatesFound}`);
    return;
  }
  if (stage === 'license-check') {
    if (status === 'skipped') console.log(`  [${item}] источник доверенный — проверка лицензии пропущена`);
    if (status === 'done') console.log(`  [${item}] лицензия подтверждена: ${event.license}`);
    if (status === 'rejected') console.log(`  [${item}] ОТКЛОНЁН: ${event.reason}`);
    return;
  }
  if (stage === 'fetcher' && status === 'done') {
    console.log(`  [${item}] → исходник сохранён: ${event.artifact}`);
    return;
  }
  if (stage === 'image') {
    if (status === 'done') console.log(`  [${item}] → фото найдено (Openverse)`);
    if (status === 'none') console.log(`  [${item}] → фото не найдено, публикуем без изображения`);
    return;
  }
  if (stage === 'pdf' && status === 'done') {
    console.log(`  [${item}] → recipes/${event.mdFile}`);
    if (event.pdfFile) {
      console.log(`  [${item}] → recipes/${event.pdfFile}`);
    } else {
      console.error(`  [${item}] PDF не создан: ${event.pdfError}`);
    }
    return;
  }
  if (stage === 'candidate' && status === 'error') {
    console.error(`  [${item}] ОШИБКА: ${event.message}`);
  }
}

async function main() {
  const { count, category } = parseArgs(process.argv.slice(2));
  if (!category) {
    console.error('Использование: node index.js [количество] "категория рецептов"');
    console.error('Пример: node index.js 5 "простые завтраки"');
    process.exit(1);
  }

  console.log(`=== recipe-finder ===\nКатегория: "${category}", нужно рецептов: ${count}`);

  const summary = await runPipeline(category, count, { onProgress: cliProgress });

  console.log('\n=== Готово ===');
  console.log(`Опубликовано: ${summary.published} из ${summary.requested} запрошенных`);
  if (summary.rejected.length > 0) {
    console.log(`Отклонено: ${summary.rejected.length}`);
    summary.rejected.forEach((r) => console.log(`  - ${r.title}: ${r.reason}`));
  }
}

main().catch((err) => {
  console.error('\nОшибка пайплайна:', err.message);
  process.exit(1);
});
