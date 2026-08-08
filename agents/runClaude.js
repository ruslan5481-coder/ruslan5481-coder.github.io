const { spawn } = require('child_process');

// На Windows передача кириллицы/спецсимволов через argv в claude.cmd (который требует
// shell:true) бьётся кодировкой cmd.exe и обрезает текст. Поэтому промпт передаём
// через stdin (claude -p без аргумента-промпта читает его оттуда) — так кодировка не страдает.
function quoteForCmd(arg) {
  return `"${String(arg).replace(/"/g, '""')}"`;
}

// Вызывает Claude Code CLI в headless-режиме (claude -p) с заданным промптом.
// allowedTools ограничивает, какими инструментами агент может пользоваться.
// Асинхронный (spawn, не spawnSync) — важно для server.js: spawnSync блокирует
// весь процесс Node целиком, включая обработку HTTP-соединений.
function runClaude(prompt, { allowedTools = [], label = 'agent' } = {}) {
  const args = ['-p', '--output-format', 'json'];
  if (allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(' '));
  }

  console.log(`\n[${label}] запускаю claude -p ...`);
  const isWindows = process.platform === 'win32';

  return new Promise((resolve, reject) => {
    const child = spawn('claude', isWindows ? args.map(quoteForCmd) : args, {
      shell: isWindows,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      reject(new Error(`[${label}] Не удалось запустить claude CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`[${label}] claude CLI завершился с ошибкой (код ${code}):\n${stderr}`));
        return;
      }

      let outer;
      try {
        outer = JSON.parse(stdout);
      } catch (e) {
        reject(new Error(`[${label}] Не удалось распарсить вывод claude CLI как JSON:\n${stdout}`));
        return;
      }

      const text = outer.result ?? outer.output ?? '';
      console.log(`[${label}] готово.`);
      resolve(text);
    });

    child.stdin.end(prompt, 'utf-8');
  });
}

// Извлекает JSON-объект из текстового ответа модели (на случай, если она обернула его в ```json ... ``` или добавила текст вокруг).
function extractJson(text) {
  let cleaned = text.trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    cleaned = fenced[1].trim();
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`В ответе не найден JSON-объект:\n${text}`);
  }
  const jsonSlice = cleaned.slice(start, end + 1);
  return JSON.parse(jsonSlice);
}

module.exports = { runClaude, extractJson };
