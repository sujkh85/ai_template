/**
 * CLI Runner: claude / gemini / codex / agent / copilot 를 subprocess로 실행합니다.
 * API 키 없이 로컬 CLI 인증을 사용합니다.
 * 각 CLI 실패 또는 사용량 초과 시 Ollama REST API로 자동 폴백합니다.
 */

import { randomBytes } from 'crypto';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
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

/** PowerShell 단일 인용 문자열 안에 넣을 경로 이스케이프 */
function escapePsSingleQuotedPath(fsPath) {
  return fsPath.replace(/'/g, "''");
}

/**
 * 프롬프트를 임시 파일에 쓴 뒤 PowerShell에서 짧은 명령으로 stdin 파이프합니다.
 * (프롬프트 전체를 -Command에 넣으면 Windows 명령줄 한도 초과 → spawn ENAMETOOLONG)
 */
function buildPromptPipePowerShellCommand(innerPipeRhs) {
  const filePath = join(tmpdir(), `soa-cli-${randomBytes(12).toString('hex')}.txt`);
  return { filePath, psCmd: buildTryFinallyPipeScript(filePath, innerPipeRhs) };
}

function buildTryFinallyPipeScript(filePath, innerPipeRhs) {
  const q = escapePsSingleQuotedPath(filePath);
  return (
    `try { Get-Content -LiteralPath '${q}' -Raw | ${innerPipeRhs} } ` +
    `finally { Remove-Item -LiteralPath '${q}' -Force -ErrorAction SilentlyContinue }`
  );
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
    if (code !== 0) {
      // 실패 시에만 stderr(에러 메시지)를 기준으로 사용량 초과 여부 판단
      const errText = stderr || stdout;
      if (hasUsageLimitError(errText)) {
        reject(new Error(`[${label}] 사용량 초과 감지:\n${errText.slice(0, 300)}`));
      } else {
        reject(new Error(`[${label}] 실패 (exit ${code}):\n${errText.slice(0, 500)}`));
      }
    } else {
      // exit 0 → 정상 완료, stdout 그대로 반환 (내용 검사 안 함)
      resolve(stdout || stderr);
    }
  });

  proc.on('error', (err) => { clearTimeout(timer); reject(err); });
}

/**
 * Claude CLI (PowerShell 경유)
 */
export function runClaude(prompt, timeoutMs = CLI_TIMEOUT_MS) {
  console.log('[CLI] claude 실행 중...');

  return (async () => {
    const built = buildPromptPipePowerShellCommand(
      'claude -p - --dangerously-skip-permissions',
    );
    await writeFile(built.filePath, prompt, 'utf-8');
    try {
      return await new Promise((resolve, reject) => {
        const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', built.psCmd], {
          cwd: CWD,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0' },
        });
        proc.on('error', (err) => {
          unlink(built.filePath).catch(() => {});
          reject(err);
        });
        collectOutput(proc, 'claude', timeoutMs, resolve, reject);
      });
    } catch (err) {
      await unlink(built.filePath).catch(() => {});
      throw err;
    }
  })();
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
 * Cursor Agent CLI (--print --yolo --trust 로 비대화형 실행)
 * 사전 요구사항: agent login
 */
export function runAgent(prompt, timeoutMs = CLI_TIMEOUT_MS) {
  console.log('[CLI] agent (Cursor) 실행 중...');
  // 프롬프트를 PowerShell 인자에 넣으면 Windows 명령줄 한도·이스케이프 문제로 잘리거나 실패함 → stdin 전달
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'agent',
      ['--print', '--yolo', '--trust', '--output-format', 'text'],
      {
        cwd: CWD,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
      },
    );
    collectOutput(proc, 'agent', timeoutMs, resolve, reject);
    proc.stdin.write(prompt, 'utf-8');
    proc.stdin.end();
  });
}

/**
 * GitHub Copilot CLI (gh copilot suggest, PowerShell 경유)
 * 사전 요구사항: gh auth login + gh extension install github/gh-copilot
 */
export function runCopilot(prompt, timeoutMs = CLI_TIMEOUT_MS) {
  console.log('[CLI] copilot (gh copilot suggest) 실행 중...');
  const escaped = prompt.replace(/'/g, "''");
  const psCmd = `gh copilot suggest -t shell '${escaped}'`;

  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
      cwd: CWD,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    collectOutput(proc, 'copilot', timeoutMs, resolve, reject);
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
 * @param {string | (() => string | Promise<string>)} [ollamaPrompt] — Ollama에만 쓸 프롬프트(문자열 또는 비동기 생성). 생략 시 `prompt`와 동일.
 * @returns {{ text: string, usedFallback: boolean }}
 */
export async function withOllamaFallback(primaryFn, label, prompt, timeoutMs, ollamaPrompt) {
  async function resolveOllamaPrompt() {
    if (ollamaPrompt === undefined || ollamaPrompt === null) return prompt;
    if (typeof ollamaPrompt === 'function') return ollamaPrompt();
    return ollamaPrompt;
  }

  try {
    const text = await primaryFn(prompt, timeoutMs);
    return { text, usedFallback: false };
  } catch (err) {
    console.warn(`[CLI] ${label} 실패 → Ollama 폴백: ${err.message}`);
    try {
      const resolved = await resolveOllamaPrompt();
      const text = await runOllama(resolved, timeoutMs);
      return { text, usedFallback: true };
    } catch (ollamaErr) {
      console.warn(`[Ollama] 폴백도 실패: ${ollamaErr.message} → 빈 응답으로 계속 진행`);
      return { text: '', usedFallback: false };
    }
  }
}
