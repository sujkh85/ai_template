import { AIMessage } from '@langchain/core/messages';
import { withOllamaFallback } from '../cliRunner.js';
import { getAgentRunner } from '../agentConfig.js';
import { contextMonitor } from '../contextMonitor.js';
import { getCompletionKeyword, outputMatchesTaskCompletion } from '../goalReader.js';
import path from 'path';

export async function workerAgentNode(state) {
  const { ai, run } = getAgentRunner('worker');
  const executionMode = 'infinite-context';
  const resultDir = path.resolve(process.cwd(), process.env.RESULT_DIR ?? './result');
  const pendingTasks = state.pendingTasks ?? [];
  const completedTasks = state.completedTasks ?? [];
  const workerCount = (state.workerCount ?? 0) + 1;
  const workerIterations = Number(process.env.WORKER_ITERATIONS ?? 1);

  if (pendingTasks.length === 0) {
    console.log('[WorkerAgent] No pending tasks, skipping');
    return { messages: [], workerCount };
  }

  const currentTask = pendingTasks[0];
  const completionKeyword = getCompletionKeyword(currentTask);

  console.log(`\n[WorkerAgent] ${ai} CLI task run (${workerCount})`);
  console.log(`[WorkerAgent] Current task: "${currentTask}"`);
  console.log(`[WorkerAgent] Completion keyword: "${completionKeyword}"`);

  const recentContext = (state.messages ?? [])
    .slice(-4)
    .map((message) => {
      const role = message._getType?.() ?? message.type ?? 'message';
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content);
      return `[${role}]: ${content.slice(0, 200)}`;
    })
    .join('\n');

  const scriptRule = [
    '작업 규칙:',
    '- 파일 조회(읽기)는 프로젝트 전체에서 가능합니다.',
    '- 쓰기/수정/삭제는 반드시 result/ 디렉터리 하위에서만 수행하세요.',
    '- src/, task/, design/, 루트 파일 등 result/ 밖 경로는 절대 변경하지 마세요.',
    '- 실행용 스크립트가 필요하면 result/script/ 하위에만 생성하세요.',
    '- ../ 경로 또는 절대경로(C:\\, /)로는 생성/수정/삭제하지 마세요.',
    '- result/ 디렉터리가 없으면 생성한 뒤 그 안에서만 작업하세요.',
    '',
  ].join('\n');

  const prompt = [
    '당신은 자율 실행 에이전트입니다.',
    `현재 작업 디렉터리: ${process.cwd()}`,
    `실제 파일 생성 허용 경로: ${resultDir}`,
    `실행 모드: ${executionMode}`,
    '',
    scriptRule,
    '--- goal.md + design bundle 전체 문맥 ---',
    state.goContent ?? '(내용 없음)',
    '---',
    '',
    `완료된 태스크: ${completedTasks.join(', ') || '없음'}`,
    `현재 실행할 태스크: ${currentTask}`,
    '',
    `이전 작업 문맥:\n${recentContext || '(없음)'}`,
    '',
    '임무:',
    `1. 위 문맥을 바탕으로 "${currentTask}" 태스크를 실제로 수행하세요.`,
    '1-1. 실행 모드가 infinite-context 라면 반복적으로 문서를 처음부터 읽지 말고, infinite-context MCP 메모리를 우선 조회/갱신하며 이어서 작업하세요.',
    '2. 파일 작업이 필요하면 result/ 하위에만 새 파일을 생성하세요. 기존 파일 수정은 금지입니다.',
    `3. 작업이 끝나면 정확히 "${completionKeyword}" 를 포함해 응답하세요.`,
    '4. 이전 작업 결과물이 있으면 이어서 작업하세요.',
    '',
    '지금 바로 작업을 시작하세요.',
  ].join('\n');

  const { text: output, usedFallback } = await withOllamaFallback(run, ai, prompt);
  contextMonitor.update(usedFallback ? 'ollama' : ai, [{ content: output }], `${prompt}\n\n${output}`);

  const isCompleted = outputMatchesTaskCompletion(output, completionKeyword, currentTask);

  const isIterationDone = workerCount >= workerIterations;
  const treatIterationAsCompletion = false;

  console.log(`[WorkerAgent] Output preview: ${output.slice(0, 200)}...`);
  console.log(`[WorkerAgent] Completed: ${isCompleted}, iteration done: ${isIterationDone}`);

  const filePattern = /(?:created?|wrote?|saved?|생성|수정)\s*[:\s]*([^\s,\n]+\.[a-zA-Z]+)/gi;
  const detectedFiles = [...output.matchAll(filePattern)].map((match) => match[1]);

  const shouldCompleteTask = isCompleted || (treatIterationAsCompletion && isIterationDone);

  const newCompletedTasks = shouldCompleteTask
    ? [...completedTasks, currentTask]
    : completedTasks;

  const newPendingTasks = shouldCompleteTask
    ? pendingTasks.slice(1)
    : pendingTasks;

  if (shouldCompleteTask) {
    console.log(`[WorkerAgent] Task finished: "${currentTask}"`);
    console.log(`[WorkerAgent] Remaining tasks: ${newPendingTasks.length}`);
  }

  return {
    messages: [
      new AIMessage(`[WorkerAgent/${ai}] task "${currentTask}" (${workerCount})\n${output}`),
    ],
    workerCount,
    completedTasks: newCompletedTasks,
    pendingTasks: newPendingTasks,
    changedFiles: [...(state.changedFiles ?? []), ...detectedFiles],
  };
}
