/**
 * go.md 파일을 읽고 파싱합니다.
 *
 * go.md 구조:
 *   [사용자 작성 영역]  ← 태스크 정의, ### 헤더로 태스크 구분
 *   <!-- AUTO-GENERATED -->  ← 이 아래는 자동 생성 (무시)
 *   [진행 상황 / 세션 로그]  ← 완료 태스크 복원에 사용
 */

import fs from 'fs/promises';
import path from 'path';

const AUTO_SEPARATOR = '<!-- AUTO-GENERATED:';

/**
 * go.md 파일을 읽어 내용, 태스크 목록, 완료 태스크를 반환합니다.
 *
 * @returns {{
 *   content: string,       전체 파일 내용
 *   userContent: string,   사용자 작성 영역만
 *   tasks: string[],       파싱된 전체 태스크 목록
 *   completedTasks: string[], 이전 세션에서 완료된 태스크
 *   pendingTasks: string[], 아직 남은 태스크
 *   title: string,
 *   filePath: string
 * }}
 */
export async function readGoFile(goFilePath) {
  const resolved = path.resolve(goFilePath);

  let content;
  try {
    content = await fs.readFile(resolved, 'utf-8');
  } catch (err) {
    throw new Error(`go.md 파일을 읽을 수 없습니다: ${resolved}\n${err.message}`);
  }

  // 사용자 영역 / 자동 생성 영역 분리
  const sepIdx = content.indexOf(AUTO_SEPARATOR);
  const userContent = sepIdx >= 0 ? content.slice(0, sepIdx) : content;
  const autoContent = sepIdx >= 0 ? content.slice(sepIdx)   : '';

  const title    = extractTitle(userContent);
  const tasks    = extractTasks(userContent);

  // 자동 생성 영역에서 완료 태스크 복원 (- [x] 패턴)
  const completedTasks = extractCompletedTasks(autoContent);
  const pendingTasks   = tasks.filter((t) => !completedTasks.includes(t));

  return {
    content,
    userContent,
    tasks,
    completedTasks,
    pendingTasks,
    title,
    filePath: resolved,
  };
}

/**
 * go.md 사용자 영역에서 H1 제목을 추출합니다.
 */
function extractTitle(userContent) {
  const match = userContent.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : 'go.md 작업';
}

/**
 * go.md 사용자 영역에서 ### 태스크 항목들을 추출합니다.
 * AUTO-GENERATED 구분선 이전 영역만 스캔합니다.
 */
function extractTasks(userContent) {
  const tasks = [];
  const lines = userContent.split('\n');

  for (const line of lines) {
    // ### 로 시작하는 줄을 태스크로 인식
    const match = line.match(/^###\s+(.+)/);
    if (match) {
      tasks.push(match[1].trim());
    }
  }

  // ### 섹션이 없으면 ## 섹션을 태스크로 파싱 (단, 특정 섹션명 제외)
  if (tasks.length === 0) {
    const IGNORE_HEADERS = ['프로젝트', '기술', '주의', '태스크', '개요', '설정'];
    for (const line of lines) {
      const match = line.match(/^##\s+(.+)/);
      if (match && !IGNORE_HEADERS.some((kw) => match[1].includes(kw))) {
        tasks.push(match[1].trim());
      }
    }
  }

  // 그래도 없으면 전체를 단일 태스크로
  if (tasks.length === 0) {
    tasks.push('전체 작업 실행');
  }

  return tasks;
}

/**
 * 자동 생성 영역에서 완료된 태스크 목록을 복원합니다.
 * "- [x] 태스크명" 패턴을 파싱합니다.
 */
function extractCompletedTasks(autoContent) {
  if (!autoContent) return [];

  // "진행 상황" 섹션의 "- [x]" 항목만 추출
  const progressSection = extractSection(autoContent, '## 진행 상황');
  if (!progressSection) return [];

  const completed = [];
  const lines = progressSection.split('\n');
  for (const line of lines) {
    const match = line.match(/^-\s+\[x\]\s+(.+)/i);
    if (match) {
      completed.push(match[1].trim());
    }
  }
  return completed;
}

/**
 * 마크다운에서 특정 ## 섹션의 내용을 추출합니다.
 */
function extractSection(content, header) {
  const startIdx = content.indexOf(header);
  if (startIdx < 0) return '';

  const afterHeader = content.slice(startIdx + header.length);

  // 다음 ## 섹션 시작 전까지만 추출
  const nextSection = afterHeader.search(/\n##\s/);
  return nextSection >= 0 ? afterHeader.slice(0, nextSection) : afterHeader;
}

/**
 * 완료 키워드를 go.md의 태스크 이름에서 생성합니다.
 * 에이전트는 이 키워드를 출력하면 완료로 간주됩니다.
 */
export function getCompletionKeyword(taskName) {
  const numbered = taskName.match(/^태스크\s*(\d+)/i);
  if (numbered) return `태스크${numbered[1]} 완료`;

  const numberedEn = taskName.match(/^task\s*(\d+)/i);
  if (numberedEn) return `task${numberedEn[1]} complete`;

  return `${taskName.slice(0, 20)} 완료`;
}
