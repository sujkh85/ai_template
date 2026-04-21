/**
 * 자율 에이전트 실행 시스템 — 진입점
 *
 * 사이클 흐름:
 *   1. go.md 읽기 (태스크 + 이전 완료 상태 파싱)
 *   2. LangGraph로 에이전트 실행
 *   3. 사이클 종료 시 go.md에 결과 기록
 *   4. AUTO_RESTART=true 이면 새 Node 프로세스 스폰 (새 채팅 세션)
 *   5. 남은 태스크 없으면 완전 종료
 */

import './loadEnv.js';
import { buildGraph }        from './graph.js';
import { readGoFile }        from './goReader.js';
import { loadDesignBundle, augmentGoContent } from './designBundle.js';
import { contextMonitor }    from './contextMonitor.js';
import { writeGoProgress, getNextSessionNumber } from './goWriter.js';
import { launchNextSession } from './sessionLauncher.js';
import { getConfigSummary, getWorkerIterations } from './agentConfig.js';
import { HumanMessage }      from '@langchain/core/messages';
import fs                    from 'fs/promises';
import path                  from 'path';

async function main() {
  const executionMode  = process.env.EXECUTION_MODE ?? 'go-md';
  const isInfiniteContextMode = executionMode === 'infinite-context';
  const goFilePath     = process.env.GO_FILE ?? './go.md';
  const agentFilePath  = process.env.AGENT_FILE ?? './agent.md';
  const requirementsFilePath = process.env.REQUIREMENTS_FILE ?? './requirements.md';
  const autoRestart    = process.env.AUTO_RESTART !== 'false'; // 기본 true
  const recursionLimit = Number(process.env.RECURSION_LIMIT ?? 5000);

  // ─── 세션 번호 계산 ──────────────────────────────────────
  const sessionNumber = await getNextSessionNumber(goFilePath);
  printBanner(sessionNumber);

  // ─── 실행 컨텐츠 로딩 ──────────────────────────────────────
  let goData;
  if (!isInfiniteContextMode) {
    try {
      goData = await readGoFile(goFilePath);
    } catch (err) {
      console.error(`\n[ERROR] ${err.message}`);
      console.error('go.md 파일을 생성하거나 GO_FILE 환경변수를 올바른 경로로 설정하세요.');
      process.exit(1);
    }
  }

  let augmentedGoContent = '';
  let allTasks = [];
  let previouslyCompleted = [];
  let pendingTasks = [];

  if (isInfiniteContextMode) {
    const [agentContent, requirementsContent] = await Promise.all([
      fs.readFile(path.resolve(agentFilePath), 'utf-8').catch(() => ''),
      fs.readFile(path.resolve(requirementsFilePath), 'utf-8').catch(() => ''),
    ]);

    augmentedGoContent =
      `# Autopilot Source (infinite-context mode)\n\n` +
      `## agent.md\n${agentContent || '(agent.md 없음)'}\n\n` +
      `## requirements.md\n${requirementsContent || '(requirements.md 없음)'}\n`;

    allTasks = ['requirements 기반 다음 최우선 작업 실행'];
    previouslyCompleted = [];
    pendingTasks = [...allTasks];

    console.log(`📄 mode: infinite-context`);
    console.log(`📄 agent.md: ${path.resolve(agentFilePath)}`);
    console.log(`📄 requirements.md: ${path.resolve(requirementsFilePath)}`);
    console.log('📝 태스크: 무한 컨텍스트 기반 자율 진행');
  } else {
    const designBundle = await loadDesignBundle({ cwd: process.cwd() });
    augmentedGoContent = augmentGoContent(goData.userContent, designBundle);

    console.log(`📄 go.md: ${goData.filePath}`);
    if (process.env.DESIGN_DIR) {
      console.log(`📁 DESIGN_DIR: ${path.resolve(process.cwd(), process.env.DESIGN_DIR)}`);
    }
    console.log(`📋 프로젝트: ${goData.title}`);
    console.log(`📝 전체 태스크: ${goData.tasks.length}개`);

    // 이전 세션 완료 태스크 (go.md 자동 생성 영역에서 복원)
    previouslyCompleted = goData.completedTasks;
    if (previouslyCompleted.length > 0) {
      console.log(`\n[Resume] 이전 완료 태스크 (${previouslyCompleted.length}개):`);
      previouslyCompleted.forEach((t) => console.log(`   ✅ ${t}`));
    }
    allTasks = goData.tasks;
    pendingTasks = goData.pendingTasks;
  }

  if (pendingTasks.length === 0) {
    console.log('\n✅ go.md의 모든 태스크가 완료되었습니다.');
    console.log('   새로운 작업을 추가하려면 go.md를 수정하세요.');
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
        `[세션 ${sessionNumber}] go.md 기반 자율 실행 시작.\n\n` +
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

  // ─── go.md 업데이트 ──────────────────────────────────────
  const exitReason = handoffTriggered
    ? '컨텍스트 토큰 임계치 도달'
    : finalPending.length === 0
      ? '모든 태스크 완료'
      : '정상 종료';

  if (!isInfiniteContextMode) {
    await writeGoProgress({
      goFilePath,
      completedTasks: finalCompleted,
      pendingTasks:   finalPending,
      allTasks,
      changedFiles:   result.changedFiles ?? [],
      contextMonitor,
      exitReason,
      sessionNumber,
    });
  } else {
    console.log('[Main] infinite-context 모드: go.md 진행상황 기록은 생략');
  }

  // ─── 다음 세션 시작 여부 판단 ────────────────────────────
  const hasMoreWork = finalPending.length > 0;

  if (hasMoreWork && autoRestart) {
    console.log(`\n[Main] 남은 태스크 ${finalPending.length}개 → 새 세션 자동 시작`);
    launchNextSession({ sessionNumber: sessionNumber + 1, delayMs: 3000 });
  } else if (!hasMoreWork) {
    console.log('\n🎉 go.md의 모든 태스크를 완료했습니다!');
    console.log('   새로운 작업을 추가하려면 go.md를 수정하고 npm start를 실행하세요.');
  } else {
    console.log('\n[Main] AUTO_RESTART=false — 자동 재시작 비활성화');
    console.log('   npm start를 다시 실행하면 남은 태스크를 이어서 진행합니다.');
  }
}

function printBanner(sessionNumber) {
  console.log('╔═══════════════════════════════════════════════════╗');
  console.log(`║   자율 에이전트 실행 시스템 — 세션 ${String(sessionNumber).padEnd(14)}║`);
  console.log('║   go.md 기반 | LangChain + claude/gemini/codex   ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');
}

function printResult({ handoffTriggered, finalCompleted, finalPending, changedFiles }) {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  if (handoffTriggered) {
    console.log('║   ⚠️  컨텍스트 한도 도달 — go.md 기록 후 재시작   ║');
  } else if (finalPending.length === 0) {
    console.log('║   ✅ 모든 태스크 완료!                            ║');
  } else {
    console.log('║   🔄 사이클 종료 — go.md 기록 후 재시작          ║');
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
