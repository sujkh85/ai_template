import './loadEnv.js';
import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import {
  saveTaskDocToInfiniteContext,
  persistInfiniteContextHandoff,
  closeInfiniteContextClient,
} from './cliRunner.js';

const DEFAULT_TASK_DIR = './task';
const DEFAULT_TASK_GLOB = '**/*.md';
const EXPORT_FILE = '.task-memory-export.json';
const CHECKPOINT_FILE = '.db-save-task-session.json';

async function main() {
  const cwd = process.cwd();
  const taskDir = path.resolve(cwd, process.env.TASK_DIR ?? DEFAULT_TASK_DIR);
  const pattern = process.env.TASK_GLOB ?? DEFAULT_TASK_GLOB;
  const maxChars = Number(process.env.TASK_DB_SAVE_MAX_CHARS ?? 200_000);
  const maxFilesPerSession = Number(process.env.TASK_DB_SAVE_MAX_FILES_PER_SESSION ?? 20);
  const maxSaveRetries = Number(process.env.TASK_DB_SAVE_RETRIES ?? 3);
  const checkpointPath = path.resolve(taskDir, CHECKPOINT_FILE);

  await fs.mkdir(taskDir, { recursive: true });

  const files = await glob(pattern, {
    cwd: taskDir,
    nodir: true,
    windowsPathsNoEscape: true,
  });
  const sorted = [...files].sort((a, b) => a.localeCompare(b, 'en'));
  if (sorted.length === 0) {
    throw new Error(`task 문서가 없습니다: ${taskDir}`);
  }

  console.log(`[DbSaveTask] taskDir: ${taskDir}`);
  console.log(`[DbSaveTask] files: ${sorted.length}`);

  const checkpoint = await readCheckpoint(checkpointPath);
  let startIndex = Number(checkpoint?.nextIndex ?? 0);
  const exportRows = Array.isArray(checkpoint?.rows) ? checkpoint.rows : [];
  let savedCount = Number(checkpoint?.savedCount ?? 0);

  while (startIndex < sorted.length) {
    const endIndexExclusive = Math.min(startIndex + maxFilesPerSession, sorted.length);
    console.log(`[DbSaveTask] session range: ${startIndex + 1}..${endIndexExclusive}`);

    for (let i = startIndex; i < endIndexExclusive; i += 1) {
      const rel = sorted[i];
      const full = path.join(taskDir, rel);
      let content = await fs.readFile(full, 'utf-8');
      if (content.length > maxChars) {
        content = `${content.slice(0, maxChars)}\n\n(길이 제한으로 일부만 저장됨)`;
      }

      const name = rel.split(path.sep).join('/');
      const ok = await saveTaskWithRetry({
        name,
        content,
        taskDir,
        maxRetries: maxSaveRetries,
      });

      if (ok) savedCount += 1;
      upsertExportRow(exportRows, { name, content });
      console.log(`[DbSaveTask] ${ok ? 'saved' : 'skipped'}: ${name}`);
    }

    const done = endIndexExclusive >= sorted.length;
    if (done) {
      break;
    }

    await writeCheckpoint(checkpointPath, {
      taskDir,
      nextIndex: endIndexExclusive,
      savedCount,
      total: sorted.length,
      rows: exportRows,
      updatedAt: new Date().toISOString(),
      note: 'infinite-context handoff checkpoint',
    });

    await persistInfiniteContextHandoff(
      [
        '[db-save-task handoff]',
        `taskDir: ${taskDir}`,
        `nextIndex: ${endIndexExclusive}`,
        `total: ${sorted.length}`,
        'nextAction: resume db-save-task and continue remaining files',
      ].join('\n'),
      {
        stage: 'db-save-task',
        nextIndex: endIndexExclusive,
        total: sorted.length,
      },
    );

    console.log('[DbSaveTask] 체크포인트 저장 후 같은 세션에서 다음 범위를 이어서 처리합니다.');
    startIndex = endIndexExclusive;
  }

  // MCP 조회 실패 시를 대비한 로컬 백업
  const exportPath = path.resolve(taskDir, EXPORT_FILE);
  await fs.writeFile(
    exportPath,
    JSON.stringify(
      {
        savedAt: new Date().toISOString(),
        total: exportRows.length,
        rows: exportRows,
      },
      null,
      2,
    ),
    'utf-8',
  );

  await safeUnlink(checkpointPath);
  console.log(`[DbSaveTask] infinite-context 저장 성공: ${savedCount}/${sorted.length}`);
  console.log(`[DbSaveTask] backup: ${exportPath}`);
}

async function saveTaskWithRetry({ name, content, taskDir, maxRetries }) {
  const retries = Number.isFinite(maxRetries) && maxRetries > 0 ? Math.floor(maxRetries) : 1;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const ok = await saveTaskDocToInfiniteContext({
      name,
      content,
      metadata: {
        source: 'db-save-task',
        taskDir,
        attempt,
      },
    });
    if (ok) return true;
    if (attempt < retries) {
      console.warn(`[DbSaveTask] retry ${attempt}/${retries - 1} 실패: ${name}`);
    }
  }
  return false;
}

function upsertExportRow(rows, nextRow) {
  const index = rows.findIndex((row) => row.name === nextRow.name);
  if (index >= 0) {
    rows[index] = nextRow;
  } else {
    rows.push(nextRow);
  }
}

async function readCheckpoint(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCheckpoint(filePath, payload) {
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

main()
  .catch((error) => {
    console.error(`\n[DbSaveTask] ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeInfiniteContextClient();
  });
