/**
 * 각 AI의 컨텍스트 사용량을 추적하고 임계치 도달 시 핸드오프를 트리거합니다.
 *
 * 한도(LIMIT)는 선택 사항입니다. 환경변수로 설정하지 않으면 사용량만 표시됩니다.
 * 한도를 설정하면 핸드오프 임계치 체크와 사용률(%) 표시가 활성화됩니다.
 *   CLAUDE_CONTEXT_LIMIT=200000
 *   GEMINI_CONTEXT_LIMIT=1048576
 *   CODEX_CONTEXT_LIMIT=128000
 *   OLLAMA_CONTEXT_LIMIT=131072
 */

function getLimit(key) {
  const envKey = `${key.toUpperCase()}_CONTEXT_LIMIT`;
  const val = process.env[envKey];
  return val ? Number(val) : null;
}

const THRESHOLD = Number(process.env.CONTEXT_THRESHOLD ?? 0.9);

class ContextMonitor {
  constructor() {
    // 사용한 모델만 동적으로 추가됨
    this.usage = {};
  }

  extractTokensFromText(text = '') {
    if (!text) return 0;

    const patterns = [
      /total(?:\s+)?tokens?\s*[:=]\s*([\d,]+)/i,
      /input(?:\s+)?tokens?\s*[:=]\s*([\d,]+)/i,
      /output(?:\s+)?tokens?\s*[:=]\s*([\d,]+)/i,
      /prompt(?:\s+)?tokens?\s*[:=]\s*([\d,]+)/i,
      /completion(?:\s+)?tokens?\s*[:=]\s*([\d,]+)/i,
    ];

    let sum = 0;
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match?.[1]) continue;
      sum += Number(match[1].replace(/,/g, '')) || 0;
    }

    return sum;
  }

  estimateTokensFromText(text = '') {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  extractTokens(agentKey, messages, textFallback = '') {
    let total = 0;
    for (const msg of messages) {
      const meta = msg.response_metadata;
      if (!meta) continue;

      if (meta.usage?.input_tokens !== undefined) {
        total += (meta.usage.input_tokens ?? 0) + (meta.usage.output_tokens ?? 0);
      } else if (meta.tokenUsage?.totalTokens !== undefined) {
        total += meta.tokenUsage.totalTokens;
      } else if (meta.usageMetadata?.totalTokenCount !== undefined) {
        total += meta.usageMetadata.totalTokenCount;
      }
    }

    if (total > 0) return total;

    const parsed = this.extractTokensFromText(textFallback);
    if (parsed > 0) return parsed;

    return this.estimateTokensFromText(textFallback);
  }

  update(agentKey, messages, textFallback = '') {
    const tokens = this.extractTokens(agentKey, messages, textFallback);
    this.usage[agentKey] = (this.usage[agentKey] ?? 0) + tokens;

    const verbose = process.env.VERBOSE !== 'false';
    if (verbose) {
      const used  = this.usage[agentKey];
      const limit = getLimit(agentKey);
      if (limit) {
        const pct = ((used / limit) * 100).toFixed(1);
        console.log(`[ContextMonitor] ${agentKey}: +${tokens} → 누적 ${used.toLocaleString()} / ${limit.toLocaleString()} (${pct}%)`);
      } else {
        console.log(`[ContextMonitor] ${agentKey}: +${tokens} → 누적 ${used.toLocaleString()} tokens`);
      }
    }
    return tokens;
  }

  isNearLimit(agentKey) {
    const limit = getLimit(agentKey);
    if (!limit) return false;
    return (this.usage[agentKey] ?? 0) / limit >= THRESHOLD;
  }

  anyNearLimit() {
    return Object.keys(this.usage).some((k) => this.isNearLimit(k));
  }

  getSummary() {
    const used = Object.entries(this.usage).filter(([, v]) => v > 0);
    if (used.length === 0) return '(사용 없음)';

    return used
      .map(([key, tokens]) => {
        const limit = getLimit(key);
        if (limit) {
          const pct    = ((tokens / limit) * 100).toFixed(1);
          const filled = Math.round(Number(pct) / 10);
          const bar    = '█'.repeat(filled) + '░'.repeat(Math.max(0, 10 - filled));
          return `| ${key.padEnd(6)} | ${bar} | ${pct.padStart(5)}% | ${tokens.toLocaleString().padStart(10)} / ${limit.toLocaleString()} |`;
        }
        return `| ${key.padEnd(6)} | ${tokens.toLocaleString().padStart(10)} tokens |`;
      })
      .join('\n');
  }

  reset() {
    this.usage = {};
  }
}

export const contextMonitor = new ContextMonitor();
