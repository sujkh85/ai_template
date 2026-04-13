/**
 * CLI Runner: claude / gemini / codex 를 subprocess로 실행합니다.
 * API 키 없이 로컬 CLI 인증을 사용합니다.
 * 각 CLI 실패 또는 사용량 초과 시 Ollama REST API로 자동 폴백합니다.
 */

import { spawn } from 'child_process';

const CWD = process.cwd();
const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS ?? 600_000);
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma3:12b';

const USAGE_LIMIT_PATTERNS = [
  /usage limit/i,
  /rate.?limit/i,
  /quota.?exceeded/i,
  /too many requests/i,
  /overloaded/i,
  /capacity exceeded/i,
  /billing/i,
  /out of credits/i,
  /insufficient_quota/i,
  /429/,
];

function hasUsageLimitError(text) {
  return USAGE_LIMIT_PATTERNS.some((p) => p.test(text));
}

function collectOutput(proc, label, timeoutMs, resolve, reject) {
  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (d) => { process.stdout.write(d); stdout += d.toString(); });
  proc.stderr.on('data', (d) => { process.stderr.write(d); stderr += d.toString(); });

  const timer = setTimeout(() => {
    proc.kill();
    reject(new Error(`[${label}] 타임아웃 (${timeoutMs / 1000}초)`));
  }, timeoutMs);

  proc.on('close', (code) => {
    clearTimeout(timer);
    const out = stdout || stderr;
    if (code !== 0) {
      reject(new Error(`[${label}] 실패 (exit ${code}):\n${out.slice(0, 500)}`));
    } else if (hasUsageLimitError(out)) {
      reject(new Error(`[${label}] 사용량 초과 감지:\n${out.slice(0, 300)}`));
    } else {
      resolve(out);
    }
  });

  proc.on('error', (err) => { clearTimeout(timer); reject(err); });
}

/**
 * Claude CLI (PowerShell 경유)
 */
export function runClaude(prompt, timeoutMs = CLI_TIMEOUT_MS) {
  console.log('[CLI] claude 실행 중...');
  const escaped = prompt.replace(/'/g, "''");
  const psCmd = `claude -p '${escaped}' --dangerously-skip-permissions`;

  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      cwd: CWD,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    collectOutput(proc, 'claude', timeoutMs, resolve, reject);
  });
}

/**
 * Gemini CLI (stdin으로 프롬프트 전달)
 */
export function runGemini(prompt, timeoutMs = CLI_TIMEOUT_MS) {
  console.log('[CLI] gemini 실행 중...');

  return new Promise((resolve, reject) => {
    const proc = spawn('cmd.exe', ['/c', 'gemini', '-p', ' ', '--yolo'], {
      cwd: CWD,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    collectOutput(proc, 'gemini', timeoutMs, resolve, reject);
    proc.stdin.write(prompt, 'utf-8');
    proc.stdin.end();
  });
}

/**
 * Codex CLI (stdin으로 프롬프트 전달)
 */
export function runCodex(prompt, timeoutMs = CLI_TIMEOUT_MS) {
  console.log('[CLI] codex 실행 중...');

  return new Promise((resolve, reject) => {
    const proc = spawn('cmd.exe', ['/c', 'codex', 'exec', '--full-auto', '--skip-git-repo-check', '-'], {
      cwd: CWD,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    collectOutput(proc, 'codex', timeoutMs, resolve, reject);
    proc.stdin.write(prompt, 'utf-8');
    proc.stdin.end();
  });
}

/**
 * Ollama 로컬 모델 — 폴백용 (REST API)
 */
export async function runOllama(prompt, timeoutMs = 300_000, model = OLLAMA_MODEL) {
  console.log(`[Ollama API] ${OLLAMA_URL} → ${model} 실행 중...`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama API 오류: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return data.response ?? '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 폴백 래퍼 — primaryFn 실패 시 Ollama로 자동 전환
 * @returns {{ text: string, usedFallback: boolean }}
 */
export async function withOllamaFallback(primaryFn, label, prompt, timeoutMs) {
  try {
    const text = await primaryFn(prompt, timeoutMs);
    return { text, usedFallback: false };
  } catch (err) {
    console.warn(`[CLI] ${label} 실패 → Ollama 폴백: ${err.message}`);
    try {
      const text = await runOllama(prompt, timeoutMs);
      return { text, usedFallback: true };
    } catch (ollamaErr) {
      console.warn(`[Ollama] 폴백도 실패: ${ollamaErr.message} → 빈 응답으로 계속 진행`);
      return { text: '', usedFallback: true };
    }
  }
}
