/**
 * CLI Runner: claude / gemini / codex / agent / copilot 를 subprocess로 실행합니다.
 * API 키 없이 로컬 CLI 인증을 사용합니다.
 * 각 CLI 실패 또는 사용량 초과 시 Ollama REST API로 자동 폴백합니다.
 */

import { getResolvedNpmCacheDir } from './loadEnv.js';
import { randomBytes } from 'crypto';
import { createReadStream } from 'fs';
import { writeFile, unlink, readdir, stat } from 'fs/promises';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve, relative, isAbsolute } from 'path';
import { spawn } from 'child_process';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';

const PROJECT_CWD = process.cwd();
const RESULT_DIR = resolveResultDir(PROJECT_CWD, process.env.RESULT_DIR ?? './result');
const CWD = PROJECT_CWD;
const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS ?? 1_800_000);
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'gemma3:12b';
const EXECUTION_MODE = process.env.EXECUTION_MODE ?? 'infinite-context';
const INFINITE_CONTEXT_SERVER = process.env.INFINITE_CONTEXT_SERVER_NAME ?? 'infinite-context';
const INFINITE_CONTEXT_MCP_COMMAND = process.env.INFINITE_CONTEXT_MCP_COMMAND ?? 'npx';

function splitMcpArgs(envValue) {
  return String(envValue ?? '-y infinite-context')
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** npx 는 --cache 로 깨진 ~/.npm 캐시를 우회한다. (@langchain/mcp-adapters stdio env 도 동시에 맞춤) */
function getInfiniteContextMcpArgs() {
  const parts = splitMcpArgs(process.env.INFINITE_CONTEXT_MCP_ARGS);
  const cmd = INFINITE_CONTEXT_MCP_COMMAND.trim();
  const exe = basename(cmd.replace(/\\/g, '/')).toLowerCase();
  const cacheDir = getResolvedNpmCacheDir();
  if (exe === 'npx' || exe === 'npx.cmd') {
    return ['--cache', cacheDir, ...parts];
  }
  return parts;
}
const ROOT_FOLDER_NAME = basename(PROJECT_CWD);
const AUTO_SCOPE_ID = sanitizeScopeId(ROOT_FOLDER_NAME) || 'project';
const SNAPSHOT_IGNORE_DIRS = new Set(['.git', 'node_modules']);
const IS_WIN32 = process.platform === 'win32';

mkdirSync(RESULT_DIR, { recursive: true });

function isPathInside(baseDir, targetPath) {
  const rel = relative(baseDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function normalizeRelPath(baseDir, targetPath) {
  return relative(baseDir, targetPath).split('\\').join('/');
}

async function captureWorkspaceSnapshot(baseDir) {
  const fileMap = new Map();

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);
      const relPath = normalizeRelPath(baseDir, absolutePath);

      if (relPath === '') continue;
      if (entry.isDirectory()) {
        if (SNAPSHOT_IGNORE_DIRS.has(entry.name)) continue;
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;

      const stats = await stat(absolutePath);
      fileMap.set(relPath, `${stats.size}:${stats.mtimeMs}`);
    }
  }

  await walk(baseDir);
  return fileMap;
}

function detectWorkspaceViolations(beforeSnapshot, afterSnapshot) {
  const violations = [];

  for (const [relPath, signature] of afterSnapshot.entries()) {
    if (!beforeSnapshot.has(relPath)) {
      violations.push(`created ${relPath}`);
      continue;
    }
    if (beforeSnapshot.get(relPath) !== signature) {
      violations.push(`modified ${relPath}`);
    }
  }

  for (const relPath of beforeSnapshot.keys()) {
    if (!afterSnapshot.has(relPath)) {
      violations.push(`deleted ${relPath}`);
    }
  }

  return violations;
}

async function withWriteScopeGuard(label, runFn) {
  // 기존 result/ 전용 쓰기 제한을 제거하고 프로젝트 루트 작업을 허용합니다.
  return runFn();
}

function resolveResultDir(projectCwd, configuredPath) {
  const absolute = resolve(projectCwd, configuredPath);
  const rel = relative(projectCwd, absolute);
  const isInsideProject = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!isInsideProject) {
    throw new Error(`RESULT_DIR must be inside project root: ${absolute}`);
  }
  return absolute;
}

let mcpClientPromise;

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

async function getInfiniteContextClient() {
  if (!mcpClientPromise) {
    mcpClientPromise = Promise.resolve(
      new MultiServerMCPClient({
        onConnectionError: 'ignore',
        useStandardContentBlocks: true,
        mcpServers: {
          [INFINITE_CONTEXT_SERVER]: {
            transport: 'stdio',
            command: INFINITE_CONTEXT_MCP_COMMAND,
            args: getInfiniteContextMcpArgs(),
            env: {
              ...process.env,
              npm_config_cache: getResolvedNpmCacheDir(),
              NPM_CONFIG_CACHE: getResolvedNpmCacheDir(),
            },
          },
        },
      }),
    );
  }
  return mcpClientPromise;
}

function getInfiniteContextScope() {
  return {
    project_id: AUTO_SCOPE_ID,
    session_id: AUTO_SCOPE_ID,
  };
}

function sanitizeScopeId(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function invokeFirstAvailableTool(toolNames, argVariants, timeout = 15_000) {
  const client = await getInfiniteContextClient();
  const tools = await client.getTools();
  const tool = tools.find((t) => toolNames.includes(t.name));
  if (!tool) return { ok: false, text: '', toolName: '' };

  for (const args of argVariants) {
    try {
      const output = await tool.invoke(args, { timeout });
      const text = normalizeToolText(output).trim();
      return { ok: true, text, toolName: tool.name };
    } catch {
      // 서버별 인자 스키마 차이를 흡수하기 위해 다음 후보를 시도합니다.
    }
  }
  return { ok: false, text: '', toolName: tool.name };
}

export async function persistInfiniteContextHandoff(note, metadata = {}) {
  if (EXECUTION_MODE !== 'infinite-context') return false;
  try {
    const client = await getInfiniteContextClient();
    const tools = await client.getTools();
    const candidates = ['save_memory', 'memory_save', 'store_memory'];
    const tool = tools.find((t) => candidates.includes(t.name));
    if (!tool) return false;

    const payload = typeof note === 'string' ? note : JSON.stringify(note);
    const scope = getInfiniteContextScope();
    const tryArgs = [
      { key: 'make-design-handoff', content: payload, metadata, ...scope },
      { content: payload, metadata },
      { text: payload, metadata },
      { memory: payload, metadata },
    ];

    for (const args of tryArgs) {
      try {
        await tool.invoke(args, { timeout: 15_000 });
        return true;
      } catch {
        // 스키마 차이를 흡수하기 위해 여러 형태를 시도합니다.
      }
    }
  } catch {
    // MCP가 없으면 파일 체크포인트만으로 이어갑니다.
  }
  return false;
}

export async function saveTaskDocToInfiniteContext({ name, content, metadata = {} }) {
  if (EXECUTION_MODE !== 'infinite-context') return false;
  const payload = [
    '[task-doc]',
    `name: ${name}`,
    `saved_at: ${new Date().toISOString()}`,
    '',
    content,
  ].join('\n');

  try {
    const scope = getInfiniteContextScope();
    const result = await invokeFirstAvailableTool(
      ['save_memory', 'memory_save', 'store_memory'],
      [
        { key: `task-doc::${name}`, content: payload, metadata: { ...metadata, type: 'task-doc', name }, ...scope },
        { content: payload, metadata: { ...metadata, type: 'task-doc', name } },
        { text: payload, metadata: { ...metadata, type: 'task-doc', name } },
        { memory: payload, metadata: { ...metadata, type: 'task-doc', name } },
      ],
    );
    return result.ok;
  } catch {
    return false;
  }
}

export async function loadTaskDocsFromInfiniteContext(query = 'task-doc') {
  if (EXECUTION_MODE !== 'infinite-context') return '';
  try {
    const scope = getInfiniteContextScope();
    const result = await invokeFirstAvailableTool(
      ['search_and_inject_memory', 'inject_relevant_memories', 'memory_search'],
      [
        { task_description: query, top_k: 20, ...scope },
        { query, topK: 20, ...scope },
        { query, limit: 20 },
        { query, limit: 20, ...scope },
        { query, ...scope },
        { query },
        { text: query },
        { input: query },
      ],
      20_000,
    );
    return result.text || '';
  } catch {
    return '';
  }
}

function normalizeToolText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return result.map((item) => normalizeToolText(item)).join('\n');
  if (typeof result === 'object') {
    if (typeof result.content === 'string') return result.content;
    if (Array.isArray(result.content)) {
      return result.content
        .map((block) => {
          if (typeof block === 'string') return block;
          if (typeof block?.text === 'string') return block.text;
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    return JSON.stringify(result);
  }
  return String(result);
}

async function readInfiniteContextMemory(prompt) {
  if (EXECUTION_MODE !== 'infinite-context') return '';
  try {
    const client = await getInfiniteContextClient();
    const tools = await client.getTools();
    const candidates = ['search_and_inject_memory', 'inject_relevant_memories', 'memory_search'];
    const tool = tools.find((t) => candidates.includes(t.name));
    if (!tool) return '';

    const query = String(prompt).slice(0, 700);
    const scope = getInfiniteContextScope();
    const tryArgs = [
      { task_description: query, top_k: 5, ...scope },
      { query, topK: 5, ...scope },
      { query, limit: 5, ...scope },
      { query, limit: 5 },
      { query },
      { text: query },
      { input: query },
    ];

    for (const args of tryArgs) {
      try {
        const output = await tool.invoke(args, { timeout: 15_000 });
        const text = normalizeToolText(output).trim();
        if (text) return text.slice(0, 4000);
      } catch {
        // 다양한 MCP 서버 스키마 차이를 흡수하기 위해 다음 인자 형태를 시도합니다.
      }
    }
  } catch {
    // MCP 연결 실패 시 기본 프롬프트만 사용합니다.
  }
  return '';
}

export async function closeInfiniteContextClient() {
  if (!mcpClientPromise) return;
  try {
    const client = await mcpClientPromise;
    if (typeof client?.close === 'function') {
      await client.close();
    }
  } catch {
    // ignore close errors
  } finally {
    mcpClientPromise = undefined;
  }
}

async function buildPromptWithInfiniteContext(prompt) {
  const memoryContext = await readInfiniteContextMemory(prompt);
  if (!memoryContext) return prompt;
  return [
    '[Infinite Context MCP Memory]',
    memoryContext,
    '',
    '[Current Task]',
    prompt,
  ].join('\n');
}

/**
 * Claude CLI
 * - Windows: PowerShell로 임시 파일 → stdin 파이프(명령줄 길이 한도 회피)
 * - macOS/Linux: 동일 임시 파일을 fs.createReadStream으로 claude stdin에 연결
 */
export function runClaude(prompt, timeoutMs = CLI_TIMEOUT_MS) {
  console.log('[CLI] claude 실행 중...');

  return withWriteScopeGuard('claude', async () => {
    const built = buildPromptPipePowerShellCommand(
      'claude -p - --dangerously-skip-permissions',
    );
    await writeFile(built.filePath, prompt, 'utf-8');
    try {
      if (IS_WIN32) {
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
      }

      return await new Promise((resolve, reject) => {
        const filePath = built.filePath;
        const finish = (fn, arg) => {
          unlink(filePath).catch(() => {});
          fn(arg);
        };

        const proc = spawn('claude', ['-p', '-', '--dangerously-skip-permissions'], {
          cwd: CWD,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0' },
        });

        proc.on('error', (err) => finish(reject, err));

        const rs = createReadStream(filePath, { encoding: 'utf-8' });
        rs.on('error', (err) => finish(reject, err));
        rs.pipe(proc.stdin);

        collectOutput(
          proc,
          'claude',
          timeoutMs,
          (out) => finish(resolve, out),
          (err) => finish(reject, err),
        );
      });
    } catch (err) {
      await unlink(built.filePath).catch(() => {});
      throw err;
    }
  });
}

/**
 * Gemini CLI (stdin으로 프롬프트 전달)
 */
export function runGemini(prompt, timeoutMs = CLI_TIMEOUT_MS) {
  console.log('[CLI] gemini 실행 중...');

  return withWriteScopeGuard('gemini', () => (
    new Promise((resolve, reject) => {
      const geminiArgs = ['-p', ' ', '--yolo'];
      const proc = IS_WIN32
        ? spawn('cmd.exe', ['/c', 'gemini', ...geminiArgs], {
          cwd: CWD,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0' },
        })
        : spawn('gemini', geminiArgs, {
          cwd: CWD,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0' },
        });
      collectOutput(proc, 'gemini', timeoutMs, resolve, reject);
      proc.stdin.write(prompt, 'utf-8');
      proc.stdin.end();
    })
  ));
}

/**
 * Codex CLI (stdin으로 프롬프트 전달)
 */
export function runCodex(prompt, timeoutMs = CLI_TIMEOUT_MS) {
  console.log('[CLI] codex 실행 중...');

  return withWriteScopeGuard('codex', () => (
    new Promise((resolve, reject) => {
      const codexArgs = ['exec', '--full-auto', '--skip-git-repo-check', '-'];
      const proc = IS_WIN32
        ? spawn('cmd.exe', ['/c', 'codex', ...codexArgs], {
          cwd: CWD,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0' },
        })
        : spawn('codex', codexArgs, {
          cwd: CWD,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0' },
        });
      collectOutput(proc, 'codex', timeoutMs, resolve, reject);
      proc.stdin.write(prompt, 'utf-8');
      proc.stdin.end();
    })
  ));
}

/**
 * Cursor Agent CLI (--print --yolo --trust 로 비대화형 실행)
 * - Windows: codex/gemini 와 동일하게 cmd.exe /c 로 실행 (PATH·PATHEXT 해석 일치, spawn ENOENT 완화)
 * - 사전 요구사항: agent login, 터미널에서 `agent --version` 동작할 것 (PATH에 Cursor CLI 포함)
 */
export function runAgent(prompt, timeoutMs = CLI_TIMEOUT_MS) {
  console.log('[CLI] agent (Cursor) 실행 중...');
  // 프롬프트를 PowerShell 인자에 넣으면 Windows 명령줄 한도·이스케이프 문제로 잘리거나 실패함 → stdin 전달
  return withWriteScopeGuard('agent', () => (
    new Promise((resolve, reject) => {
      const agentArgs = ['--print', '--yolo', '--trust', '--output-format', 'text'];
      const proc = IS_WIN32
        ? spawn('cmd.exe', ['/c', 'agent', ...agentArgs], {
          cwd: CWD,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0' },
        })
        : spawn('agent', agentArgs, {
          cwd: CWD,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0' },
        });
      collectOutput(proc, 'agent', timeoutMs, resolve, reject);
      proc.stdin.write(prompt, 'utf-8');
      proc.stdin.end();
    })
  ));
}

/**
 * GitHub Copilot CLI (gh copilot suggest)
 * - Windows: PowerShell로 인자 이스케이프(명령줄 한도·따옴표 이슈 완화)
 * - macOS/Linux: gh argv 배열로 직접 실행
 * 사전 요구사항: gh auth login + gh extension install github/gh-copilot
 */
export function runCopilot(prompt, timeoutMs = CLI_TIMEOUT_MS) {
  console.log('[CLI] copilot (gh copilot suggest) 실행 중...');

  return withWriteScopeGuard('copilot', () => (
    new Promise((resolve, reject) => {
      let proc;
      if (IS_WIN32) {
        const escaped = prompt.replace(/'/g, "''");
        const psCmd = `gh copilot suggest -t shell '${escaped}'`;
        proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
          cwd: CWD,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0' },
        });
      } else {
        proc = spawn('gh', ['copilot', 'suggest', '-t', 'shell', prompt], {
          cwd: CWD,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, FORCE_COLOR: '0' },
        });
      }
      collectOutput(proc, 'copilot', timeoutMs, resolve, reject);
    })
  ));
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
    const promptWithMemory = await buildPromptWithInfiniteContext(prompt);
    const text = await primaryFn(promptWithMemory, timeoutMs);
    return { text, usedFallback: false };
  } catch (err) {
    console.warn(`[CLI] ${label} 실패 → Ollama 폴백: ${err.message}`);
    try {
      const resolved = await resolveOllamaPrompt();
      const ollamaPromptWithMemory = await buildPromptWithInfiniteContext(resolved);
      const text = await runOllama(ollamaPromptWithMemory, timeoutMs);
      return { text, usedFallback: true };
    } catch (ollamaErr) {
      console.warn(`[Ollama] 폴백도 실패: ${ollamaErr.message} → 빈 응답으로 계속 진행`);
      return { text: '', usedFallback: false };
    }
  }
}
