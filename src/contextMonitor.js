/**
 * 각 AI의 컨텍스트 사용량을 추적하고 임계치 도달 시 핸드오프를 트리거합니다.
 */

const LIMITS = {
  gemini:  1_048_576,
  codex:     128_000,
  claude:    200_000,
  ollama:    131_072,
};

const THRESHOLD = Number(process.env.CONTEXT_THRESHOLD ?? 0.8);

class ContextMonitor {
  constructor() {
    this.usage = {
      gemini: 0,
      codex:  0,
      claude: 0,
      ollama: 0,
    };
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
      console.log(
        `[ContextMonitor] ${agentKey}: +${tokens} → 누적 ${this.usage[agentKey].toLocaleString()} / ${(LIMITS[agentKey] ?? 131072).toLocaleString()} (${this.getPercent(agentKey)}%)`
      );
    }
    return tokens;
  }

  getPercent(agentKey) {
    return (((this.usage[agentKey] ?? 0) / (LIMITS[agentKey] ?? 131072)) * 100).toFixed(1);
  }

  isNearLimit(agentKey) {
    return (this.usage[agentKey] ?? 0) / (LIMITS[agentKey] ?? 131072) >= THRESHOLD;
  }

  anyNearLimit() {
    return Object.keys(this.usage).some((k) => this.isNearLimit(k));
  }

  getSummary() {
    return Object.entries(this.usage)
      .map(([key, used]) => {
        const limit = LIMITS[key] ?? 131072;
        const pct = ((used / limit) * 100).toFixed(1);
        const filled = Math.round(pct / 10);
        const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, 10 - filled));
        return `| ${key.padEnd(6)} | ${bar} | ${pct}% | ${used.toLocaleString()} / ${limit.toLocaleString()} |`;
      })
      .join('\n');
  }

  reset() {
    for (const key of Object.keys(this.usage)) {
      this.usage[key] = 0;
    }
  }
}

export const contextMonitor = new ContextMonitor();
