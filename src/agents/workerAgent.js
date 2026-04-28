import { AIMessage } from '@langchain/core/messages';
import path from 'path';
import { withOllamaFallback } from '../cliRunner.js';
import { getAgentRunner } from '../agentConfig.js';
import { contextMonitor } from '../contextMonitor.js';
import { getCompletionKeyword, outputMatchesTaskCompletion } from '../goalReader.js';

export async function workerAgentNode(state) {
  const { ai, run } = getAgentRunner('worker');
  const executionMode = 'infinite-context';
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
  const goalConstraint = extractGoalLengthConstraint(state.goContent ?? '');

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

  const scriptRule = buildAgentFileRules();

  const prompt = [
    '당신은 자율 실행 에이전트입니다.',
    `현재 작업 디렉터리: ${process.cwd()}`,
    `파일 작성은 프로젝트 루트 내부 허용 폴더(task_data, design, task, result 등)로만 하세요. ${process.env.ALLOW_AGENT_SRC_EDIT === 'true' ? '(이번 세션은 src 편집 예외 허용)' : '`src/`는 수정 금지.'}`,
    `실행 모드: ${executionMode}`,
    '',
    scriptRule,
    '--- goal.md + design bundle 전체 문맥 ---',
    state.goContent ?? '(내용 없음)',
    '---',
    '',
    `완료된 태스크: ${completedTasks.join(', ') || '없음'}`,
    `현재 실행할 태스크: ${currentTask}`,
    goalConstraint
      ? `goal.md 완료 기준(분량): 최소 ${goalConstraint.minChars.toLocaleString()}자${goalConstraint.maxChars ? `, 권장 최대 ${goalConstraint.maxChars.toLocaleString()}자` : ''}`
      : 'goal.md 완료 기준(분량): 별도 수치 조건 없음',
    '',
    `이전 작업 문맥:\n${recentContext || '(없음)'}`,
    '',
    '임무:',
    `1. 위 문맥을 바탕으로 "${currentTask}" 태스크를 실제로 수행하세요.`,
    '1-1. 실행 모드가 infinite-context 라면 반복적으로 문서를 처음부터 읽지 말고, infinite-context MCP 메모리를 우선 조회/갱신하며 이어서 작업하세요.',
    '2. 파일 작업이 필요하면 프로젝트 루트 내부에서 생성/수정하세요.',
    `3. 작업이 끝나면 정확히 "${completionKeyword}" 를 포함해 응답하세요.`,
    '4. 이전 작업 결과물이 있으면 이어서 작업하세요.',
    '',
    '지금 바로 작업을 시작하세요.',
  ].join('\n');

  const { text: output, usedFallback } = await withOllamaFallback(run, ai, prompt);
  contextMonitor.update(usedFallback ? 'ollama' : ai, [{ content: output }], `${prompt}\n\n${output}`);

  const keywordCompleted = outputMatchesTaskCompletion(output, completionKeyword, currentTask);
  const lengthCheck = evaluateLengthConstraint(output, goalConstraint);
  const isCompleted = keywordCompleted && lengthCheck.passed;

  const isIterationDone = workerCount >= workerIterations;
  const treatIterationAsCompletion = false;

  console.log(`[WorkerAgent] Output preview: ${output.slice(0, 200)}...`);
  if (!lengthCheck.passed) {
    console.log(
      `[WorkerAgent] 분량 미달: ${lengthCheck.actualChars.toLocaleString()}자 < 최소 ${lengthCheck.minChars.toLocaleString()}자`,
    );
  }
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

function extractGoalLengthConstraint(goContent = '') {
  const text = String(goContent);
  const rangeMatch = text.match(/한\s*화당\s*([0-9,]{3,7})\s*(?:~|-|–|—)\s*([0-9,]{3,7})\s*자/i);
  if (rangeMatch) {
    const minChars = parseNumber(rangeMatch[1]);
    const maxChars = parseNumber(rangeMatch[2]);
    if (minChars > 0) {
      return { minChars, maxChars: maxChars > 0 ? maxChars : null };
    }
  }

  const minMatch = text.match(/([0-9,]{3,7})\s*자\s*이상/i) ?? text.match(/최소\s*([0-9,]{3,7})\s*자/i);
  if (minMatch) {
    const minChars = parseNumber(minMatch[1]);
    if (minChars > 0) return { minChars, maxChars: null };
  }

  return null;
}

function evaluateLengthConstraint(output, constraint) {
  const actualChars = countCharacters(output);
  if (!constraint?.minChars) {
    return { passed: true, actualChars, minChars: 0 };
  }
  return {
    passed: actualChars >= constraint.minChars,
    actualChars,
    minChars: constraint.minChars,
  };
}

function countCharacters(text = '') {
  const normalized = String(text)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\r/g, '')
    .trim();
  return normalized.length;
}

function parseNumber(value) {
  return Number(String(value ?? '').replace(/,/g, '')) || 0;
}

/**
 * 자율 워커(CLI 에이전트)가 런타임 코드(src/)를 건드리지 않도록 프롬프트 제약을 구성합니다.
 * ALLOW_AGENT_SRC_EDIT=true 일 때만 예외(개발/디버그용).
 */
function buildAgentFileRules() {
  const cwd = process.cwd();
  const allowSrcEdit = process.env.ALLOW_AGENT_SRC_EDIT === 'true';
  const taskDir = process.env.TASK_DIR ?? './task';
  const designDir = process.env.DESIGN_DIR ?? './design';
  const resultDir = process.env.RESULT_DIR ?? './result';

  const lines = [
    '작업 규칙:',
    '- 파일 조회/생성/수정/삭제는 현재 프로젝트 루트 내부에서만 수행하세요.',
    '- ../ 경로 또는 프로젝트 루트 밖 절대경로로는 생성/수정/삭제하지 마세요.',
  ];

  if (!allowSrcEdit) {
    lines.push(
      '- **절대 금지**: `./src/` 및 그 아래 모든 경로에 대한 생성·수정·삭제·이동·리네임. (pnpm start 파이프라인 코드 보호)',
      '- 코드/런타임 변경이 필요하면 사용자에게 요청하고, 산출물은 기획·작업 폴더에만 작성하세요.',
    );
  } else {
    lines.push(
      '- *(세션 예외: ALLOW_AGENT_SRC_EDIT=true)* `src/` 편집이 허용됩니다. 필요한 최소 변경만 하세요.',
    );
  }

  lines.push(
    `- 권장 산출 경로 예: ${path.join(cwd, 'task_data')}, ${path.join(cwd, designDir)}, ${path.join(cwd, taskDir)}, ${path.join(cwd, resultDir)}, ${path.join(cwd, 'handoff')}`,
    '',
  );

  return lines.join('\n');
}
