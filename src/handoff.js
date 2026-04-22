/**
 * 컨텍스트 임계치 도달 시 현재 작업 상태를 파일로 저장합니다.
 * 다음 세션이 이 파일을 읽고 작업을 이어받을 수 있습니다.
 */

import fs from 'fs/promises';
import path from 'path';

function resolveSafePathInside(baseDir, targetPath) {
  const absoluteBase = path.resolve(baseDir);
  const absoluteTarget = path.resolve(targetPath);
  const rel = path.relative(absoluteBase, absoluteTarget);
  const isInside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!isInside) {
    throw new Error(`Path must stay inside result directory: ${absoluteTarget}`);
  }
  return absoluteTarget;
}

/**
 * 핸드오프 MD 파일을 생성합니다.
 */
export async function generateHandoff(state, contextMonitor, goContent = '') {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace('T', '_')
    .replace(/:/g, '-')
    .split('.')[0];

  const resultDir = path.resolve(process.cwd(), process.env.RESULT_DIR ?? './result');
  const handoffDir = resolveSafePathInside(resultDir, path.resolve(process.cwd(), process.env.HANDOFF_DIR ?? './result/handoff'));
  const filename = resolveSafePathInside(handoffDir, path.join(handoffDir, `handoff_${timestamp}.md`));

  const completedTasks = state.completedTasks ?? [];
  const pendingTasks   = state.pendingTasks   ?? [];

  const recentMessages = (state.messages ?? [])
    .slice(-10)
    .map((m) => {
      const role = m._getType?.() ?? m.type ?? 'unknown';
      const content =
        typeof m.content === 'string'
          ? m.content.slice(0, 300)
          : JSON.stringify(m.content).slice(0, 300);
      return `**[${role}]** ${content}${content.length >= 300 ? '...' : ''}`;
    })
    .join('\n\n');

  const changedFiles = (state.changedFiles ?? [])
    .map((f) => `- ${f}`)
    .join('\n') || '- (기록 없음)';

  const content = `# 작업 인계 파일 (Handoff)

> 생성 시각: ${now.toLocaleString('ko-KR')}
> 중단 사유: **컨텍스트 사용량 임계치(${Math.round(Number(process.env.CONTEXT_THRESHOLD ?? 0.9) * 100)}%) 도달**

---

## 컨텍스트 사용량

| AI     | 사용률     | 사용량                    |
|--------|------------|---------------------------|
${contextMonitor.getSummary()}

---

## 완료된 태스크

${completedTasks.length > 0
  ? completedTasks.map((t) => `- [x] ${t}`).join('\n')
  : '- (없음)'}

## 미완료 태스크

${pendingTasks.length > 0
  ? pendingTasks.map((t) => `- [ ] ${t}`).join('\n')
  : '- (없음)'}

---

## 최근 대화 내용 (마지막 10개)

${recentMessages || '(없음)'}

---

## 변경된 파일

${changedFiles}

---

## goal.md 원본 내용

\`\`\`markdown
${goContent.slice(0, 2000)}${goContent.length > 2000 ? '\n...(생략)' : ''}
\`\`\`

---

## 다음 세션 시작 방법

1. \`.env\` 파일에서 \`HANDOFF_FILE\` 값을 아래 경로로 설정하세요:
   \`\`\`
   HANDOFF_FILE=${filename}
   \`\`\`
2. \`npm start\`로 재시작하면 완료된 태스크를 건너뛰고 이어서 진행합니다.

\`\`\`bash
HANDOFF_FILE=${filename} npm start
\`\`\`
`;

  await fs.mkdir(handoffDir, { recursive: true });
  await fs.writeFile(filename, content, 'utf-8');

  console.log(`\n[Handoff] 작업 파일 저장 완료: ${filename}`);
  return filename;
}

/**
 * 이전 핸드오프 파일을 읽어 completedTasks를 복원합니다.
 */
export async function loadHandoff(handoffFile) {
  try {
    const content = await fs.readFile(handoffFile, 'utf-8');
    const completed = [];
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^- \[x\] (.+)/);
      if (match) completed.push(match[1].trim());
    }
    console.log(`[Handoff] 이전 완료 태스크 복원: ${completed.join(', ') || '없음'}`);
    return completed;
  } catch {
    return [];
  }
}
