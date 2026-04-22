import './loadEnv.js';
import path from 'path';
import { spawn } from 'child_process';

const DEFAULT_DB_PATH = 'data/infinite_context_keeper.sqlite';

function runPythonDelete(dbPath) {
  const script = `
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
cur = conn.cursor()

deleted_semantic = cur.execute("""
DELETE FROM semantic_memories
WHERE memory_key LIKE 'task-doc::%'
   OR content LIKE '%[task-doc]%'
   OR metadata_json LIKE '%"type":"task-doc"%'
   OR metadata_json LIKE '%"source":"db-save-task"%'
""").rowcount

deleted_memories = cur.execute("""
DELETE FROM memories
WHERE title LIKE '%task%'
   OR body LIKE '%[task-doc]%'
""").rowcount

deleted_tasks = cur.execute("DELETE FROM tasks").rowcount

conn.commit()
conn.close()

print(f"deleted_semantic={deleted_semantic}")
print(f"deleted_memories={deleted_memories}")
print(f"deleted_tasks={deleted_tasks}")
`.trim();

  return new Promise((resolve, reject) => {
    const proc = spawn('python', ['-c', script, dbPath], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (error) => {
      reject(error);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `python exited with ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function main() {
  const dbPath = path.resolve(process.cwd(), process.env.INFINITE_CONTEXT_DB_PATH ?? DEFAULT_DB_PATH);

  try {
    const output = await runPythonDelete(dbPath);
    console.log(`[db-delete] target: ${dbPath}`);
    console.log(output);
  } catch (error) {
    console.error(`[db-delete] failed: ${error.message}`);
    console.error('[db-delete] Python(>=3) 설치 여부와 DB 경로를 확인하세요.');
    process.exitCode = 1;
  }
}

main();
