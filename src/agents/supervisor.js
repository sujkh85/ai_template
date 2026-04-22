/**
 * Supervisor: goal.md의 태스크 목록을 바탕으로 다음 실행할 에이전트를 결정합니다.
 */

import { withOllamaFallback } from '../cliRunner.js';
import { getAgentRunner, agentAiConfig } from '../agentConfig.js';
import { contextMonitor } from '../contextMonitor.js';

export async function supervisorNode(state) {
  const { ai, run } = getAgentRunner('supervisor');
  const completedTasks = state.completedTasks ?? [];
  const pendingTasks   = state.pendingTasks   ?? [];
  const continuousMode = process.env.CONTINUOUS_MODE === 'true';

  // 모든 태스크 완료 체크
  if (pendingTasks.length === 0) {
    if (continuousMode) {
      console.log('[Supervisor] 모든 태스크 완료 → 연속 모드: 처음부터 재시작');
      return {
        next: 'worker',
        completedTasks: [],
        pendingTasks: state.allTasks ?? [],
        workerCount: 0,
      };
    }
    console.log('[Supervisor] 모든 태스크 완료 → FINISH');
    return { next: 'FINISH' };
  }

  const nextTask = pendingTasks[0];
  const conversationSummary = (state.messages ?? [])
    .slice(-4)
    .map((m) => {
      const role = m._getType?.() ?? m.type ?? 'message';
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `[${role}]: ${content.slice(0, 200)}`;
    })
    .join('\n');

  const prompt =
    `당신은 자율 실행 시스템의 Supervisor입니다.\n` +
    `goal.md 파일에 정의된 태스크를 순서대로 실행합니다.\n\n` +
    `현재 상황:\n` +
    `- 완료된 태스크: ${completedTasks.join(', ') || '없음'}\n` +
    `- 남은 태스크: ${pendingTasks.join(', ')}\n` +
    `- 다음 태스크: ${nextTask}\n\n` +
    `최근 대화:\n${conversationSummary}\n\n` +
    `다음에 실행할 에이전트를 선택하세요.\n` +
    `가능한 값: worker | FINISH\n` +
    `남은 태스크가 있으면 반드시 "worker"를 출력하세요.\n` +
    `단어 하나만 출력하세요.`;

  const { text: response, usedFallback } = await withOllamaFallback(run, ai, prompt);
  contextMonitor.update(usedFallback ? 'ollama' : ai, [{ content: response }], `${prompt}\n\n${response}`);

  const text = response.trim().toLowerCase();
  let next = text.includes('finish') ? 'FINISH' : 'worker';

  // 남은 태스크가 있는데 FINISH로 가려 하면 강제로 worker로
  if (next === 'FINISH' && pendingTasks.length > 0) {
    console.log('[Supervisor] 남은 태스크 있음 → worker로 강제 전환');
    next = 'worker';
  }

  console.log(`\n[Supervisor] 다음 태스크: "${nextTask}" → ${next}`);
  return { next };
}
