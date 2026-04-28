/**
 * 자율 에이전트 실행 시스템 — 진입점
 *
 * 사이클 흐름:
 *   1. goal.md 읽기 (태스크 + 이전 완료 상태 파싱)
 *   2. LangGraph로 에이전트 실행
 *   3. 사이클 종료 시 goal.md에 결과 기록
 *   4. AUTO_RESTART=true 이면 새 Node 프로세스 스폰 (새 채팅 세션)
 *   5. 남은 태스크 없으면 완전 종료
 */

import './loadEnv.js';
import { buildGraph }        from './graph.js';
import { loadDesignBundle, augmentGoContent } from './designBundle.js';
import { contextMonitor }    from './contextMonitor.js';
import { launchNextSession } from './sessionLauncher.js';
import { getConfigSummary, getWorkerIterations } from './agentConfig.js';
import { loadTaskDocsFromInfiniteContext } from './cliRunner.js';
import { HumanMessage }      from '@langchain/core/messages';
import fs                    from 'fs/promises';
import path                  from 'path';

function resolveResultDir(cwd) {
  const configured = process.env.RESULT_DIR ?? './result';
  const resultDir = path.resolve(cwd, configured);
  const rel = path.relative(cwd, resultDir);
  const isInsideProject = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!isInsideProject) {
    throw new Error(`RESULT_DIR must be inside project root: ${resultDir}`);
  }
  return resultDir;
}

async function main() {
  const executionMode  = 'infinite-context';
  const agentFilePath  = process.env.AGENT_FILE ?? './agent.md';
  const goalFilePath = process.env.GO_FILE ?? './goal.md';
  const autoRestart    = process.env.AUTO_RESTART !== 'false'; // 기본 true
  const recursionLimit = Number(process.env.RECURSION_LIMIT ?? 5000);
  /** 소설/기획 위주 infinite-context에서는 기본으로 끔(명시적 true일 때만 추가) */
  const enforceTestCompletion = process.env.ENFORCE_TEST_COMPLETION === 'true';

  // ─── 세션 번호 계산 (sessionLauncher가 다음 세션에서 SESSION_NUMBER 전달) ───
  const sessionNumber = Math.max(1, Number.parseInt(process.env.SESSION_NUMBER ?? '1', 10) || 1);
  printBanner(sessionNumber);

  // ─── 실행 컨텐츠 로딩 ──────────────────────────────────────
  let augmentedGoContent = '';
  let allTasks = [];
  let previouslyCompleted = [];
  let pendingTasks = [];

  const goalResolved = path.resolve(process.cwd(), goalFilePath);
  const [agentContent, goalBody] = await Promise.all([
    fs.readFile(path.resolve(agentFilePath), 'utf-8').catch(() => ''),
    fs.readFile(goalResolved, 'utf-8').catch(() => ''),
  ]);
  const designBundle = await loadDesignBundle({ cwd: process.cwd() });
  const runtimeTaskContext = await loadRuntimeTaskContext(process.cwd());

  augmentedGoContent = augmentGoContent(
    `# Autopilot Source (infinite-context mode)\n\n` +
    `## goal.md (프로젝트 목표·제약 — 반드시 준수)\n` +
    `파일: ${goalResolved}\n\n` +
    `${goalBody.trim() || '(goal.md 없음 또는 읽기 실패)'}\n\n` +
    `## agent.md\n${agentContent || '(agent.md 없음)'}\n\n` +
    `## runtime tasks (infinite-context)\n${runtimeTaskContext.bundle || '(task 없음)'}\n`,
    designBundle,
  );

  allTasks = runtimeTaskContext.taskNames.length > 0
    ? [...runtimeTaskContext.taskNames]
    : ['goal.md 기반 다음 최우선 작업 실행'];
  if (enforceTestCompletion) {
    allTasks.push('모든 테스트 완료');
  }
  previouslyCompleted = [];
  pendingTasks = [...allTasks];

  console.log(`📄 mode: infinite-context`);
  console.log(`📄 agent.md: ${path.resolve(agentFilePath)}`);
  console.log(`📄 goal.md: ${goalResolved}`);
  console.log(`📄 runtime task source: infinite-context${runtimeTaskContext.usedFallback ? ' (local backup fallback)' : ''}`);
  if (process.env.DESIGN_DIR) {
    console.log(`📁 DESIGN_DIR: ${path.resolve(process.cwd(), process.env.DESIGN_DIR)}`);
  }
  console.log('📝 태스크: 무한 컨텍스트 기반 자율 진행');

  if (pendingTasks.length === 0) {
    console.log('\n✅ goal.md의 모든 태스크가 완료되었습니다.');
    console.log('   새로운 작업을 추가하려면 goal.md를 수정하세요.');
    process.exit(0);
  }

  console.log(`\n📌 이번 세션 실행 태스크 (${pendingTasks.length}개):`);
  pendingTasks.forEach((t, i) => console.log(`   ${i + 1}. ${t}`));

  // ─── 설정 출력 ───────────────────────────────────────────
  console.log(`\n⚙️  파이프라인: ${getConfigSummary()}`);
  console.log(`⚙️  AUTO_RESTART: ${autoRestart ? 'ON (완료/한도 후 새 세션 자동 시작)' : 'OFF'}`);
  console.log(`⚙️  Worker 반복: ${getWorkerIterations()}회`);
  console.log(`⚙️  컨텍스트 임계치: ${Math.round(Number(process.env.CONTEXT_THRESHOLD ?? 0.9) * 100)}%`);
  console.log(`⚙️  Recursion Limit: ${recursionLimit}\n`);
  console.log(`🚀 세션 ${sessionNumber} 시작\n`);

  // ─── 그래프 실행 ─────────────────────────────────────────
  const graph = buildGraph();

  const initialState = {
    messages: [
      new HumanMessage(
        `[세션 ${sessionNumber}] goal.md 기반 자율 실행 시작.\n\n` +
        `실행 모드: ${executionMode}\n` +
        `전체 태스크:\n${allTasks.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n` +
        `이미 완료된 태스크: ${previouslyCompleted.join(', ') || '없음'}\n\n` +
        `이번 세션 실행 대상:\n` +
        pendingTasks.map((t, i) => `${i + 1}. ${t}`).join('\n') +
        '\n\n각 태스크를 순서대로 완료하세요.'
      ),
    ],
    goContent:      augmentedGoContent,
    allTasks,
    completedTasks: previouslyCompleted,
    pendingTasks,
  };

  const result = await graph.invoke(initialState, { recursionLimit });

  // ─── 결과 출력 ───────────────────────────────────────────
  const finalCompleted  = result.completedTasks ?? [];
  const finalPending    = result.pendingTasks   ?? [];
  const handoffTriggered = result.handoffTriggered ?? false;

  printResult({ handoffTriggered, finalCompleted, finalPending, changedFiles: result.changedFiles });
  await saveSessionResult({
    sessionNumber,
    executionMode,
    result,
    finalCompleted,
    finalPending,
  });

  // ─── 결과 반영 ─────────────────────────────────────────────
  console.log('[Main] infinite-context 전용 모드: goal.md 진행상황 기록은 생략');

  // ─── 다음 세션 시작 여부 판단 ────────────────────────────
  const hasMoreWork = finalPending.length > 0;

  if (hasMoreWork && autoRestart) {
    console.log(`\n[Main] 남은 태스크 ${finalPending.length}개 → 새 세션 자동 시작`);
    launchNextSession({ sessionNumber: sessionNumber + 1, delayMs: 3000 });
  } else if (!hasMoreWork) {
    console.log('\n🎉 현재 세션 태스크를 완료했습니다.');
    console.log('   goal.md·agent.md·Infinite Context 메모리를 기준으로 다음 배치를 준비하거나,');
    console.log('   `pnpm run make-task` 후 다시 `pnpm start` 하면 태스크가 갱신됩니다.');
    console.log('   같은 태스크를 반복 실행하려면 환경변수 CONTINUOUS_MODE=true 를 설정하세요.');
  } else {
    console.log('\n[Main] AUTO_RESTART=false — 자동 재시작 비활성화');
    console.log('   npm start를 다시 실행하면 남은 태스크를 이어서 진행합니다.');
  }
}

async function saveSessionResult({ sessionNumber, executionMode, result, finalCompleted, finalPending }) {
  const resultDir = resolveResultDir(process.cwd());
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `session-${String(sessionNumber).padStart(3, '0')}-${timestamp}.json`;
  const filePath = path.join(resultDir, filename);

  const payload = {
    savedAt: new Date().toISOString(),
    sessionNumber,
    executionMode,
    completedTaskCount: finalCompleted.length,
    pendingTaskCount: finalPending.length,
    completedTasks: finalCompleted,
    pendingTasks: finalPending,
    changedFiles: result?.changedFiles ?? [],
    handoffTriggered: result?.handoffTriggered ?? false,
  };

  await fs.mkdir(resultDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`📦 실행 결과 저장: ${filePath}`);
}

async function loadRuntimeTaskContext(cwd) {
  const raw = await loadTaskDocsFromInfiniteContext('task-doc');
  let docs = extractTaskDocs(raw);
  let usedFallback = false;

  if (docs.length === 0) {
    const fallback = await loadTaskBackup(cwd);
    docs = fallback;
    usedFallback = fallback.length > 0;
  }

  const taskNames = docs.map((doc, index) => normalizeTaskName(doc.name, index + 1));
  const bundle = docs
    .map((doc, index) => `### ${index + 1}. ${doc.name}\n\n${doc.content}`)
    .join('\n\n---\n\n');

  return { taskNames, bundle, usedFallback };
}

function extractTaskDocs(rawText) {
  const text = (rawText ?? '').trim();
  if (!text) return [];

  const chunks = text.split(/\[task-doc\]/g).map((item) => item.trim()).filter(Boolean);
  const docs = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const nameLine = lines.find((line) => /^name:\s*/i.test(line));
    const name = nameLine ? nameLine.replace(/^name:\s*/i, '').trim() : '';
    const contentStart = lines.findIndex((line) => line.trim() === '');
    const content = contentStart >= 0 ? lines.slice(contentStart + 1).join('\n').trim() : chunk;
    if (name && content) docs.push({ name, content });
  }
  return docs.slice(0, 100);
}

async function loadTaskBackup(cwd) {
  const taskDir = path.resolve(cwd, process.env.TASK_DIR ?? './task');
  const exportPath = path.resolve(taskDir, '.task-memory-export.json');
  try {
    const raw = await fs.readFile(exportPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.rows)) return [];
    return parsed.rows
      .map((row) => ({ name: `${row?.name ?? ''}`.trim(), content: `${row?.content ?? ''}`.trim() }))
      .filter((row) => row.name && row.content);
  } catch {
    return [];
  }
}

function normalizeTaskName(name, index) {
  const cleaned = String(name ?? '')
    .replace(/\.md$/i, '')
    .replace(/^\d+\.\s*/, '')
    .trim();
  return cleaned ? `task ${index}: ${cleaned}` : `task ${index}`;
}

function printBanner(sessionNumber) {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log(`║   자율 에이전트 실행 시스템 — 세션 ${String(sessionNumber).padEnd(14)}║`);
  console.log('║ infinite-context | LangChain + claude/gemini/codex ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');
}

function printResult({ handoffTriggered, finalCompleted, finalPending, changedFiles }) {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  if (handoffTriggered) {
    console.log('║   ⚠️  컨텍스트 한도 도달 — 핸드오프 후 재시작      ║');
  } else if (finalPending.length === 0) {
    console.log('║   ✅ 모든 태스크 완료!                            ║');
  } else {
    console.log('║   🔄 사이클 종료 — 다음 세션으로 재시작             ║');
  }
  console.log('╚═══════════════════════════════════════════════════╝\n');

  console.log('─── 컨텍스트 최종 사용량 ─────────────────────────');
  console.log(contextMonitor.getSummary());

  console.log(`\n완료 태스크 (${finalCompleted.length}): ${finalCompleted.join(', ') || '없음'}`);
  console.log(`남은 태스크 (${finalPending.length}):   ${finalPending.join(', ')   || '없음'}`);
  console.log(`변경 파일: ${(changedFiles ?? []).join(', ') || '없음'}`);
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
