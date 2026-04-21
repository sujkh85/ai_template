import { runClaude, runCodex, runGemini, runAgent, runCopilot } from './cliRunner.js';

const RUNNERS = {
  claude: runClaude,
  codex: runCodex,
  gemini: runGemini,
  agent: runAgent,
  copilot: runCopilot,
};

function normalizeAi(value, fallback) {
  const key = (value ?? fallback ?? '').toString().trim().toLowerCase();
  return RUNNERS[key] ? key : fallback;
}

export const agentAiConfig = {
  supervisor: normalizeAi(process.env.SUPERVISOR_AI, 'gemini'),
  worker: normalizeAi(process.env.WORKER_AI, 'claude'),
};

export function getAgentRunner(agent) {
  const ai = agentAiConfig[agent];
  const run = RUNNERS[ai];
  if (!run) {
    throw new Error(`지원하지 않는 AI 설정: ${agent}=${ai}`);
  }
  return { ai, run };
}

export function getCliRunner(label, preferredAi = 'claude') {
  const ai = normalizeAi(preferredAi, 'claude');
  const run = RUNNERS[ai];
  if (!run) {
    throw new Error(`지원하지 않는 AI 설정: ${label}=${preferredAi}`);
  }
  return { ai, run };
}

export function getWorkerIterations() {
  return Number(process.env.WORKER_ITERATIONS ?? 1);
}

export function getConfigSummary() {
  return `supervisor(${agentAiConfig.supervisor}) -> worker(${agentAiConfig.worker}) x${getWorkerIterations()}`;
}
