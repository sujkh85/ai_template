/**
 * WorkerAgent: go.md에 정의된 태스크를 실제로 실행합니다.
 * 태스크의 완료 키워드를 감지하여 다음 태스크로 넘어갑니다.
 */

import { AIMessage } from '@langchain/core/messages';
import { withOllamaFallback } from '../cliRunner.js';
import { getAgentRunner } from '../agentConfig.js';
import { contextMonitor } from '../contextMonitor.js';
import { getCompletionKeyword } from '../goReader.js';

export async function workerAgentNode(state) {
  const { ai, run } = getAgentRunner('worker');
  const pendingTasks   = state.pendingTasks   ?? [];
  const completedTasks = state.completedTasks ?? [];
  const workerCount    = (state.workerCount   ?? 0) + 1;
  const workerIterations = Number(process.env.WORKER_ITERATIONS ?? 1);

  if (pendingTasks.length === 0) {
    console.log('[WorkerAgent] 남은 태스크 없음 → 건너뜀');
    return { messages: [], workerCount };
  }

  const currentTask = pendingTasks[0];
  const completionKeyword = getCompletionKeyword(currentTask);

  console.log(`\n[WorkerAgent] ${ai} CLI — 태스크 실행 (${workerCount}/${workerIterations} 회차)`);
  console.log(`[WorkerAgent] 현재 태스크: "${currentTask}"`);
  console.log(`[WorkerAgent] 완료 키워드: "${completionKeyword}"`);

  // 이전 작업 컨텍스트 요약
  const recentContext = (state.messages ?? [])
    .slice(-4)
    .map((m) => {
      const role = m._getType?.() ?? m.type ?? 'message';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${role}]: ${content.slice(0, 200)}`;
    })
    .join('\n');

  const prompt =
    `당신은 자율 실행 에이전트입니다.\n` +
    `현재 작업 디렉토리: ${process.cwd()}\n\n` +
    `─── go.md 전체 지시 내용 ───\n` +
    `${state.goContent ?? '(go.md 내용 없음)'}\n` +
    `─────────────────────────────\n\n` +
    `완료된 태스크: ${completedTasks.join(', ') || '없음'}\n` +
    `현재 실행할 태스크: ${currentTask}\n\n` +
    `이전 작업 컨텍스트:\n${recentContext || '(없음)'}\n\n` +
    `임무:\n` +
    `1. 위의 go.md 내용에서 "${currentTask}" 태스크를 수행하세요\n` +
    `2. 실제 파일을 생성하거나 수정하는 작업이 있다면 실제로 수행하세요\n` +
    `3. 작업이 완료되면 반드시 정확히 "${completionKeyword}"라고 출력하세요\n` +
    `4. 이전 태스크의 결과물이 있다면 그것을 바탕으로 작업하세요\n\n` +
    `지금 바로 태스크를 실행하세요.`;

  const { text: output, usedFallback } = await withOllamaFallback(run, ai, prompt);
  contextMonitor.update(usedFallback ? 'ollama' : ai, [{ content: output }], `${prompt}\n\n${output}`);

  const isCompleted = output.toLowerCase().includes(completionKeyword.toLowerCase())
    || output.includes('완료')
    || output.includes('complete');

  const isIterationDone = workerCount >= workerIterations;

  console.log(`[WorkerAgent] 출력 (앞 200자): ${output.slice(0, 200)}...`);
  console.log(`[WorkerAgent] 완료 감지: ${isCompleted}, 반복 완료: ${isIterationDone}`);

  // 변경된 파일 추출 (출력에서 파일 경로 패턴 스캔)
  const filePattern = /(?:created?|wrote?|saved?|생성|저장|수정)\s*[:\s]*([^\s,\n]+\.[a-zA-Z]+)/gi;
  const detectedFiles = [...output.matchAll(filePattern)].map((m) => m[1]);

  const newCompletedTasks = (isCompleted || isIterationDone)
    ? [...completedTasks, currentTask]
    : completedTasks;

  const newPendingTasks = (isCompleted || isIterationDone)
    ? pendingTasks.slice(1)
    : pendingTasks;

  if (isCompleted || isIterationDone) {
    console.log(`[WorkerAgent] 태스크 완료: "${currentTask}"`);
    console.log(`[WorkerAgent] 남은 태스크: ${newPendingTasks.length}개`);
  }

  return {
    messages: [
      new AIMessage(
        `[WorkerAgent/${ai}] 태스크: "${currentTask}" (${workerCount}/${workerIterations} 회차)\n${output}`
      ),
    ],
    workerCount,
    completedTasks: newCompletedTasks,
    pendingTasks:   newPendingTasks,
    changedFiles:   [...(state.changedFiles ?? []), ...detectedFiles],
  };
}
