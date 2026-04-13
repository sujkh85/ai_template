/**
 * LangGraph 워크플로우: supervisor → worker → (반복) → FINISH
 * go.md의 태스크를 순서대로 처리합니다.
 */

import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { BaseMessage } from '@langchain/core/messages';

import { supervisorNode } from './agents/supervisor.js';
import { workerAgentNode } from './agents/workerAgent.js';
import { contextMonitor } from './contextMonitor.js';
import { generateHandoff } from './handoff.js';

// ─── 공유 상태 정의 ────────────────────────────────────────
const AgentState = Annotation.Root({
  messages: Annotation({
    reducer: (existing, incoming) => [...existing, ...incoming],
    default: () => [],
  }),

  // 라우팅
  next: Annotation({ default: () => 'supervisor' }),

  // go.md 원본 내용 (실행 중 참조용)
  goContent: Annotation({ default: () => '' }),

  // 전체 태스크 목록 (go.md에서 파싱)
  allTasks: Annotation({
    reducer: (_, incoming) => incoming ?? [],
    default: () => [],
  }),

  // 완료된 태스크
  completedTasks: Annotation({
    reducer: (existing, incoming) => {
      if (incoming === null) return [];
      const set = new Set([...(existing ?? []), ...(incoming ?? [])]);
      return [...set];
    },
    default: () => [],
  }),

  // 남은 태스크 (순서 중요 — Set 사용 불가)
  pendingTasks: Annotation({
    reducer: (_, incoming) => incoming ?? [],
    default: () => [],
  }),

  // 변경된 파일 목록
  changedFiles: Annotation({
    reducer: (existing, incoming) => {
      const set = new Set([...(existing ?? []), ...(incoming ?? [])]);
      return [...set];
    },
    default: () => [],
  }),

  // 핸드오프 발생 여부
  handoffTriggered: Annotation({ default: () => false }),

  // worker 반복 카운터
  workerCount: Annotation({
    reducer: (_, incoming) => incoming ?? 0,
    default: () => 0,
  }),
});

// ─── 컨텍스트 게이트: 토큰 임계치 도달 시 핸드오프 ──────
async function contextGateNode(state) {
  if (contextMonitor.anyNearLimit()) {
    console.log('\n[ContextGate] 컨텍스트 임계치 도달 → 핸드오프 트리거');
    const handoffFile = await generateHandoff(state, contextMonitor, state.goContent);
    return { next: 'handoff', handoffTriggered: true };
  }
  return { next: 'supervisor' };
}

// ─── 핸드오프 노드 ─────────────────────────────────────────
async function handoffNode(state) {
  console.log('\n[Handoff] 작업 저장 완료. 다음 세션에서 이어서 진행하세요.');
  return {};
}

// ─── 라우팅 함수 ───────────────────────────────────────────
function supervisorRoute(state) {
  return state.next; // worker | FINISH
}

function contextGateRoute(state) {
  return state.next; // supervisor | handoff
}

// ─── 그래프 구성 ───────────────────────────────────────────
export function buildGraph() {
  const graph = new StateGraph(AgentState)
    .addNode('supervisor',   supervisorNode)
    .addNode('contextGate',  contextGateNode)
    .addNode('worker',       workerAgentNode)
    .addNode('handoff',      handoffNode)

    .addEdge(START, 'supervisor')

    .addConditionalEdges('supervisor', supervisorRoute, {
      worker: 'worker',
      FINISH: END,
    })

    .addEdge('worker', 'contextGate')

    .addConditionalEdges('contextGate', contextGateRoute, {
      supervisor: 'supervisor',
      handoff:    'handoff',
    })

    .addEdge('handoff', END);

  return graph.compile();
}

export { AgentState };
