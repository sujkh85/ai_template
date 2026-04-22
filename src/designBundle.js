/**
 * DESIGN_DIR 환경변수가 있으면 해당 폴더 아래 마크다운을 읽어
 * goal.md userContent 뒤에 붙일 참조 텍스트를 만듭니다.
 */

import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';

/**
 * @param {{ cwd: string }} options
 * @returns {Promise<string>}
 */
export async function loadDesignBundle({ cwd }) {
  const raw = process.env.DESIGN_DIR;
  if (raw === undefined || raw === '') {
    return '';
  }

  const resolved = path.resolve(cwd, raw);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    console.warn(`[DesignBundle] DESIGN_DIR 경로 없음: ${resolved}`);
    return (
      `\n\n---\n\n## 디자인 문서 번들\n\n` +
      `*(DESIGN_DIR를 찾을 수 없습니다: ${resolved})*\n`
    );
  }

  if (!stat.isDirectory()) {
    console.warn(`[DesignBundle] DESIGN_DIR가 디렉터리가 아님: ${resolved}`);
    return (
      `\n\n---\n\n## 디자인 문서 번들\n\n` +
      `*(DESIGN_DIR가 폴더가 아닙니다: ${resolved})*\n`
    );
  }

  const pattern = process.env.DESIGN_GLOB ?? '**/*.md';
  const files = await glob(pattern, {
    cwd: resolved,
    nodir: true,
    windowsPathsNoEscape: true,
  });

  const sorted = [...files].sort((a, b) => a.localeCompare(b, 'en'));
  const maxPerFile = Number(process.env.DESIGN_MAX_CHARS_PER_FILE ?? 200_000);

  const chunks = [];
  for (const rel of sorted) {
    const full = path.join(resolved, rel);
    let text = await fs.readFile(full, 'utf-8');
    if (text.length > maxPerFile) {
      text = `${text.slice(0, maxPerFile)}\n\n… (DESIGN_MAX_CHARS_PER_FILE 초과로 잘림)`;
    }
    const label = rel.split(path.sep).join('/');
    chunks.push(`### ${label}\n\n${text}`);
  }

  if (chunks.length === 0) {
    return (
      `\n\n---\n\n## 디자인 문서 번들 (DESIGN_DIR)\n\n` +
      `*(${resolved} 에서 패턴 \`${pattern}\`에 맞는 파일 없음)*\n`
    );
  }

  console.log(`[DesignBundle] ${chunks.length}개 파일 주입 (${resolved}, glob: ${pattern})`);

  return (
    `\n\n---\n\n## 디자인 문서 번들 (자동 주입)\n\n` +
    `> WORKER는 아래 문서를 **기획·제약의 단일 출처**로 참고하세요. goal.md 태스크와 충돌하면 goal.md를 우선합니다.\n\n` +
    chunks.join('\n\n---\n\n')
  );
}

/**
 * @param {string} userContent
 * @param {string} bundle
 */
export function augmentGoContent(userContent, bundle) {
  if (!bundle) return userContent;
  return userContent + bundle;
}
