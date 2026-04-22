/**
 * 사이클 완료 후 goal.md에 진행 상황과 세션 로그를 기록합니다.
 *
 * goal.md 구조:
 *   [사용자 작성 영역]  ← 태스크 정의, 수정 가능
 *   <!-- AUTO-GENERATED -->  ← 이 아래는 자동 생성
 *   [진행 상황 섹션]    ← 완료/미완료 태스크 목록
 *   [세션 로그 섹션]    ← 세션별 실행 이력
 */

import fs from 'fs/promises';
import path from 'path';

const SEPARATOR = '<!-- AUTO-GENERATED: 아래 내용은 자동 생성됩니다. 수정하지 마세요. -->';

/**
 * goal.md에 사이클 결과를 기록합니다.
 *
 * @param {object} params
 * @param {string} params.goFilePath     - goal.md 파일 경로
 * @param {string[]} params.completedTasks - 이번 세션에서 완료된 태스크
 * @param {string[]} params.pendingTasks   - 아직 남은 태스크
 * @param {string[]} params.allTasks       - 전체 태스크 목록
 * @param {string[]} params.changedFiles   - 변경된 파일 목록
 * @param {object}  params.contextMonitor - 컨텍스트 모니터 인스턴스
 * @param {string}  params.exitReason     - 종료 사유
 * @param {number}  params.sessionNumber  - 세션 번호
 */
export async function writeGoProgress({
  goFilePath,
  completedTasks,
  pendingTasks,
  allTasks,
  changedFiles,
  contextMonitor,
  exitReason,
  sessionNumber,
}) {
  const resolved = path.resolve(goFilePath);
  const raw = await fs.readFile(resolved, 'utf-8');

  // 사용자 작성 영역만 추출 (자동 생성 구분선 이전)
  const separatorIdx = raw.indexOf(SEPARATOR);
  const userContent = separatorIdx >= 0 ? raw.slice(0, separatorIdx).trimEnd() : raw.trimEnd();

  const now = new Date();
  const timestamp = now.toLocaleString('ko-KR');
  const sessionLabel = `세션 ${sessionNumber}`;

  // ─── 진행 상황 섹션 ─────────────────────────────────────
  const completedLines = completedTasks.length > 0
    ? completedTasks.map((t) => `- [x] ${t}`).join('\n')
    : '- (없음)';

  const pendingLines = pendingTasks.length > 0
    ? pendingTasks.map((t) => `- [ ] ${t}`).join('\n')
    : '- (모든 태스크 완료 ✅)';

  // ─── 세션 로그: 기존 로그 파싱 후 새 항목 추가 ─────────
  const existingLog = extractExistingLog(raw);

  const contextSummary = buildContextSummary(contextMonitor);
  const changedFilesSummary = changedFiles.length > 0
    ? changedFiles.slice(0, 10).join(', ')
    : '없음';

  const newLogEntry = [
    `### ${sessionLabel} — ${timestamp}`,
    `- **종료 사유**: ${exitReason}`,
    `- **완료 태스크**: ${completedTasks.join(', ') || '없음'}`,
    `- **남은 태스크**: ${pendingTasks.join(', ') || '없음'}`,
    `- **컨텍스트**: ${contextSummary}`,
    `- **변경 파일**: ${changedFilesSummary}`,
  ].join('\n');

  const sessionLog = existingLog
    ? `${existingLog}\n\n${newLogEntry}`
    : newLogEntry;

  // ─── 전체 goal.md 재조합 ──────────────────────────────────
  const autoSection = [
    SEPARATOR,
    '',
    '## 진행 상황',
    '',
    `> 마지막 업데이트: ${timestamp} (${sessionLabel})`,
    '',
    '### ✅ 완료된 태스크',
    '',
    completedLines,
    '',
    '### ⏳ 남은 태스크',
    '',
    pendingLines,
    '',
    '---',
    '',
    '## 세션 로그',
    '',
    sessionLog,
    '',
  ].join('\n');

  const newContent = `${userContent}\n\n${autoSection}`;
  await fs.writeFile(resolved, newContent, 'utf-8');

  console.log(`[GoWriter] goal.md 업데이트 완료: ${resolved}`);
  console.log(`[GoWriter] 완료: ${completedTasks.length}개 / 남음: ${pendingTasks.length}개`);

  return resolved;
}

/**
 * 기존 goal.md에서 세션 로그 텍스트만 추출합니다.
 */
function extractExistingLog(raw) {
  const logStart = raw.indexOf('## 세션 로그');
  if (logStart < 0) return '';

  const afterHeader = raw.slice(logStart + '## 세션 로그'.length).trimStart();
  return afterHeader.trim();
}

/**
 * contextMonitor에서 요약 문자열을 만듭니다.
 */
function buildContextSummary(contextMonitor) {
  if (!contextMonitor) return '정보 없음';
  try {
    return Object.entries(contextMonitor.usage ?? {})
      .filter(([, used]) => used > 0)
      .map(([key]) => `${key} ${contextMonitor.getPercent(key)}%`)
      .join(' / ') || '0%';
  } catch {
    return '정보 없음';
  }
}

/**
 * goal.md에서 현재 세션 번호를 계산합니다.
 * 세션 로그의 "세션 N" 중 가장 큰 N + 1을 반환합니다.
 */
export async function getNextSessionNumber(goFilePath) {
  try {
    const raw = await fs.readFile(path.resolve(goFilePath), 'utf-8');
    const matches = [...raw.matchAll(/### 세션 (\d+)/g)];
    if (matches.length === 0) return 1;
    const nums = matches.map((m) => Number(m[1]));
    return Math.max(...nums) + 1;
  } catch {
    return 1;
  }
}
