import './loadEnv.js';
import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { withOllamaFallback } from './cliRunner.js';
import { getCliRunner } from './agentConfig.js';

const DEFAULT_DESIGN_DIR = './design';
const DEFAULT_OUTPUT_FILE = './go.md';

function resolveDesignInjectionMode() {
  // subprocess CLI(claude/codex/gemini 등)는 Cursor 채팅의 @파일 자동 포함이 없어
  // 기본은 design 본문을 프롬프트에 직접 넣는 inline이 안전합니다.
  const raw = (process.env.MAKE_GO_DESIGN_INJECTION ?? 'inline').toLowerCase().trim();
  if (raw === 'file') return 'file';
  if (raw === 'inline') return 'inline';
  if (raw === 'auto') {
    // 예전에는 claude를 file로 두었으나, CLI는 @경로만으로는 문서를 못 읽는 경우가 많음 → inline
    return 'inline';
  }
  console.warn(`[MakeGo] 알 수 없는 MAKE_GO_DESIGN_INJECTION="${raw}" → inline로 처리`);
  return 'inline';
}

async function main() {
  const cwd = process.cwd();
  const designDir = path.resolve(cwd, process.env.DESIGN_DIR ?? DEFAULT_DESIGN_DIR);
  const outputFile = path.resolve(cwd, process.env.GO_FILE ?? DEFAULT_OUTPUT_FILE);
  const pattern = process.env.DESIGN_GLOB ?? '**/*.md';

  const { ai, run } = getCliRunner('go', process.env.GO_AI ?? process.env.WORKER_AI ?? 'claude');
  const injectionMode = resolveDesignInjectionMode();

  const refs = await listDesignFileRefs({ designDir, pattern });
  console.log(`[MakeGo] design: ${designDir}`);
  console.log(`[MakeGo] output: ${outputFile}`);
  console.log(`[MakeGo] ai: ${ai}`);
  console.log(`[MakeGo] design injection: ${injectionMode}`);
  console.log(`[MakeGo] docs: ${refs.length}`);

  let docsCachePromise;
  function getDesignDocs() {
    if (!docsCachePromise) docsCachePromise = loadDesignDocsFromRefs(refs);
    return docsCachePromise;
  }

  const prompt =
    injectionMode === 'file'
      ? buildFileInjectionPrompt({ refs, cwd, designDir, outputFile })
      : buildInlinePrompt({ docs: await getDesignDocs(), designDir, outputFile });

  const ollamaPrompt = async () =>
    buildInlinePrompt({ docs: await getDesignDocs(), designDir, outputFile });

  const { text } = await withOllamaFallback(run, ai, prompt, undefined, ollamaPrompt);

  const normalized = normalizeDocument(text);
  let goContent = normalized;
  if (!goContent) {
    console.warn(
      '[MakeGo] AI 출력이 비었거나 go.md 형식(#으로 시작)이 아님 → design 원문을 반영한 자동 초안을 사용합니다. MAKE_GO_DESIGN_INJECTION=inline 인지 확인하세요.',
    );
    goContent = buildFallbackGo(await getDesignDocs());
  }

  await fs.writeFile(outputFile, goContent, 'utf-8');
  console.log(`[MakeGo] written: ${outputFile}`);
}

async function listDesignFileRefs({ designDir, pattern }) {
  let stat;
  try {
    stat = await fs.stat(designDir);
  } catch (error) {
    throw new Error(`design 폴더를 찾을 수 없습니다: ${designDir}\n${error.message}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`DESIGN_DIR가 디렉터리가 아닙니다: ${designDir}`);
  }

  const files = await glob(pattern, {
    cwd: designDir,
    nodir: true,
    windowsPathsNoEscape: true,
  });

  const sorted = [...files].sort((a, b) => a.localeCompare(b, 'en'));
  if (sorted.length === 0) {
    throw new Error(`design 폴더에 마크다운 파일이 없습니다: ${designDir}`);
  }

  return sorted.map((relativePath) => ({
    relativePath: relativePath.split(path.sep).join('/'),
    fullPath: path.join(designDir, relativePath),
  }));
}

async function loadDesignDocsFromRefs(refs) {
  const maxPerFile = Number(process.env.DESIGN_MAX_CHARS_PER_FILE ?? 200_000);
  const docs = [];

  for (const ref of refs) {
    let content = await fs.readFile(ref.fullPath, 'utf-8');
    if (content.length > maxPerFile) {
      content = `${content.slice(0, maxPerFile)}\n\n(문서가 길어서 일부만 사용함)`;
    }
    docs.push({
      path: ref.relativePath,
      content,
    });
  }

  return docs;
}

function workspaceRelativePosix(filePath, cwd) {
  return path.relative(cwd, filePath).split(path.sep).join('/');
}

function buildFileInjectionPrompt({ refs, cwd, designDir, outputFile }) {
  const atLines = refs.map((ref) => {
    const rel = workspaceRelativePosix(ref.fullPath, cwd);
    return `@${rel}`;
  });

  const pathLines = refs.map((ref) => `- ${ref.fullPath} (워크스페이스 상대: ${workspaceRelativePosix(ref.fullPath, cwd)})`);

  return [
    '당신은 서비스 기획서를 구현용 실행 문서로 변환하는 프로젝트 매니저입니다.',
    'design 폴더의 마크다운 **파일**을 직접 읽어 내용을 반영하고, 개발 에이전트가 바로 사용할 go.md를 작성하세요.',
    '아래 프롬프트에는 design 문서 **원문을 붙이지 않았습니다.** 반드시 @ 로 표시된 경로(또는 절대 경로)의 파일을 열어 전체 내용을 읽어야 합니다.',
    '',
    '⚠️ 출력 형식 엄수 사항:',
    '- 응답 전체가 마크다운 문서 그 자체여야 합니다.',
    '- "작성했습니다", "다음과 같습니다" 같은 설명 문장을 절대 포함하지 마세요.',
    '- 코드 펜스(```)로 감싸지 마세요.',
    '- 응답의 첫 글자는 반드시 `#` 이어야 합니다.',
    '- 절대로 내용을 요약하거나 생략하지 마세요. 토큰이 부족하더라도 "...이하 생략", "(나머지 태스크는 위와 동일한 형식으로)" 같은 표현을 쓰지 마세요.',
    '- 각 태스크를 끝까지 완전하게 작성하세요. 중간에 잘리거나 축약하지 마세요.',
    `입력 폴더: ${designDir}`,
    `출력 파일: ${outputFile}`,
    '',
    '문서 구조 규칙:',
    '- 첫 줄은 반드시 `# 프로젝트명` 형식이어야 합니다.',
    '- `## 프로젝트 개요`, `## 구현 목표`, `## 작업 원칙`, `## 태스크 목록` 섹션을 포함하세요.',
    '- 태스크는 반드시 `### 태스크 1: 이름` 형식으로 시작하세요.',
    '- 각 태스크는 구체적 작업 항목 2개 이상을 포함하세요.',
    '- 각 태스크 끝에는 반드시 `- 완료 시 응답: "태스크 N 완료"` 줄을 포함하세요.',
    '- design 문서에 없는 내용은 단정하지 말고 필요한 경우 가정이라고 표시하세요.',
    '- 구현 순서대로 태스크를 배치하세요.',
    '- 자동 생성 로그나 진행 상태 섹션은 넣지 마세요.',
    '- design에 나온 화면 이름, 표, 체크리스트, 우선순위(P0/P1)를 가능한 한 그대로 태스크에 옮기세요.',
    '',
    '읽어야 할 design 문서 (워크스페이스 기준 — 각 줄의 @ 경로로 파일을 포함·읽기):',
    ...atLines,
    '',
    '절대 경로 참고:',
    ...pathLines,
  ].join('\n');
}

function buildInlinePrompt({ docs, designDir, outputFile }) {
  const maxTotal = Number(process.env.MAKE_GO_MAX_INLINE_TOTAL_CHARS ?? 120_000);
  let bundle = docs.map((doc) => `## ${doc.path}\n\n${doc.content}`).join('\n\n---\n\n');
  if (bundle.length > maxTotal) {
    bundle = `${bundle.slice(0, maxTotal)}\n\n(일부만 포함: MAKE_GO_MAX_INLINE_TOTAL_CHARS=${maxTotal})`;
  }
  const sourceDocs = bundle;

  return [
    '당신은 서비스 기획서를 구현용 실행 문서로 변환하는 프로젝트 매니저입니다.',
    'design 폴더의 마크다운 문서를 읽고, 개발 에이전트가 바로 사용할 go.md를 작성하세요.',
    '',
    '⚠️ 출력 형식 엄수 사항:',
    '- 응답 전체가 마크다운 문서 그 자체여야 합니다.',
    '- "작성했습니다", "다음과 같습니다" 같은 설명 문장을 절대 포함하지 마세요.',
    '- 코드 펜스(```)로 감싸지 마세요.',
    '- 응답의 첫 글자는 반드시 `#` 이어야 합니다.',
    '- 절대로 내용을 요약하거나 생략하지 마세요. 토큰이 부족하더라도 "...이하 생략", "(나머지 태스크는 위와 동일한 형식으로)" 같은 표현을 쓰지 마세요.',
    '- 각 태스크를 끝까지 완전하게 작성하세요. 중간에 잘리거나 축약하지 마세요.',
    `입력 폴더: ${designDir}`,
    `출력 파일: ${outputFile}`,
    '',
    '문서 구조 규칙:',
    '- 첫 줄은 반드시 `# 프로젝트명` 형식이어야 합니다.',
    '- `## 프로젝트 개요`, `## 구현 목표`, `## 작업 원칙`, `## 태스크 목록` 섹션을 포함하세요.',
    '- 태스크는 반드시 `### 태스크 1: 이름` 형식으로 시작하세요.',
    '- 각 태스크는 구체적 작업 항목 2개 이상을 포함하세요.',
    '- 각 태스크 끝에는 반드시 `- 완료 시 응답: "태스크 N 완료"` 줄을 포함하세요.',
    '- design 문서에 없는 내용은 단정하지 말고 필요한 경우 가정이라고 표시하세요.',
    '- 구현 순서대로 태스크를 배치하세요.',
    '- 자동 생성 로그나 진행 상태 섹션은 넣지 마세요.',
    '- 아래 design 원문에 나온 화면 이름, 표, 체크리스트, 수치, 우선순위(P0/P1)를 가능한 한 그대로 태스크에 옮기세요. 추상적인 한 줄 요약으로 대체하지 마세요.',
    '',
    'design 문서 원문:',
    sourceDocs,
  ].join('\n');
}

function normalizeDocument(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';

  // 코드 펜스 안에 마크다운이 있으면 추출
  let body = trimmed;
  const fenced = body.match(/```(?:md|markdown)?\n([\s\S]*?)```/i);
  if (fenced) body = fenced[1].trim();

  // "다음은 go.md입니다" 등 앞부분 설명을 건너뛰고 첫 `#` 헤더부터 사용
  const lines = body.split('\n');
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\uFEFF/, '').trimStart();
    if (line.startsWith('#')) {
      start = i;
      break;
    }
  }
  const extracted = lines.slice(start).join('\n').trim();
  const firstLine = extracted.split('\n')[0] ?? '';
  if (!firstLine.startsWith('#')) {
    console.warn('[MakeGo] AI 응답에서 `#`로 시작하는 문서 시작을 찾지 못함 → fallback 사용');
    return '';
  }

  return extracted;
}

function buildFallbackGo(docs) {
  const projectName = extractProjectName(docs);
  const headingPool = extractHeadings(docs);
  const taskSeeds = createTaskSeeds(headingPool);
  const snippetByHeading = buildHeadingSnippetMap(docs);

  const sections = [
    `# ${projectName}`,
    '',
    '## 프로젝트 개요',
    '- design 폴더의 문서를 기준으로 구현용 실행 문서를 생성한다.',
    '- 세부 내용이 부족한 부분은 구현 중 가정으로 명시하고 문서를 보완한다.',
    '',
    '## 구현 목표',
    '- 핵심 사용자 흐름을 구현 가능한 단위로 나눈다.',
    '- MVP 범위를 먼저 완성하고 이후 확장 요소를 분리한다.',
    '',
    '## 작업 원칙',
    '- design 문서의 요구사항을 우선한다.',
    '- 모호한 요구사항은 임의 확장보다 보수적으로 구현한다.',
    '- 각 태스크 완료 시 지정된 완료 문구를 그대로 출력한다.',
    '',
    '## 참고 문서',
    ...docs.map((doc) => `- ${doc.path}`),
    '',
    '## 태스크 목록',
    ...taskSeeds.flatMap((task, index) => {
      const taskNumber = index + 1;
      const designPull = formatDesignPullForTask(task.references, snippetByHeading);
      return [
        `### 태스크 ${taskNumber}: ${task.title}`,
        ...task.items.map((item) => `- ${item}`),
        `- 참고 섹션: ${task.references.join(', ') || 'design 문서 전반'}`,
        ...designPull,
        `- 완료 시 응답: "태스크 ${taskNumber} 완료"`,
        '',
      ];
    }),
  ];

  return sections.join('\n').trim();
}

function extractProjectName(docs) {
  for (const doc of docs) {
    const match = doc.content.match(/^#\s+(.+)$/m);
    if (match) return match[1].trim();
  }
  return '프로젝트';
}

function extractHeadings(docs) {
  const headings = [];

  for (const doc of docs) {
    const matches = doc.content.matchAll(/^##\s+(.+)$/gm);
    for (const match of matches) {
      const heading = sanitizeHeading(match[1]);
      if (heading) {
        headings.push({ doc: doc.path, heading });
      }
    }
  }

  return headings;
}

function sanitizeHeading(value) {
  return value
    .replace(/^\d+\.\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function createTaskSeeds(headings) {
  const references = unique(headings.map((item) => item.heading)).slice(0, 8);

  const first = references.slice(0, 2);
  const second = references.slice(2, 4);
  const third = references.slice(4, 6);
  const fourth = references.slice(6, 8);

  return [
    {
      title: '요구사항 정리와 구현 범위 확정',
      references: first,
      items: [
        'design 문서의 핵심 요구사항과 제약사항을 정리한다.',
        'MVP 범위와 후순위 범위를 구분한다.',
      ],
    },
    {
      title: '정보 구조와 데이터 흐름 설계',
      references: second,
      items: [
        '핵심 화면과 기능 사이의 연결 구조를 정리한다.',
        '필요한 데이터 모델과 상태 흐름을 정의한다.',
      ],
    },
    {
      title: '핵심 사용자 흐름 구현',
      references: third,
      items: [
        '사용자의 첫 진입부터 핵심 행동 완료까지의 흐름을 구현한다.',
        '주요 입력, 결과, 피드백 동선을 반영한다.',
      ],
    },
    {
      title: '우선순위 기능 완성',
      references: fourth,
      items: [
        'P0 기능을 우선 구현하고 문서와 동작을 맞춘다.',
        '가정이 필요한 부분은 최소화하고 코드에 반영한다.',
      ],
    },
    {
      title: '검증과 문서 정리',
      references,
      items: [
        '주요 기능 동작을 점검하고 누락된 요구사항을 확인한다.',
        '변경된 내용과 남은 작업을 문서에 정리한다.',
      ],
    },
  ];
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

/** design 문서에서 ## 제목별 본문 스니펫 (fallback 시 에이전트가 따라갈 근거) */
function buildHeadingSnippetMap(docs) {
  const maxPerSection = Number(process.env.MAKE_GO_FALLBACK_SNIPPET_CHARS ?? 2_500);
  const map = new Map();

  for (const doc of docs) {
    const blocks = doc.content.split(/^##\s+/m).slice(1);
    for (const block of blocks) {
      const nl = block.indexOf('\n');
      const rawHeading = (nl === -1 ? block : block.slice(0, nl)).trim();
      const body = (nl === -1 ? '' : block.slice(nl + 1)).trim();
      const key = sanitizeHeading(rawHeading);
      if (!key || !body) continue;
      let snippet = body.replace(/\n{3,}/g, '\n\n');
      if (snippet.length > maxPerSection) {
        snippet = `${snippet.slice(0, maxPerSection)}\n…`;
      }
      const prev = map.get(key);
      const label = `${doc.path}`;
      const piece = `**${label}**\n${snippet}`;
      map.set(key, prev ? `${prev}\n\n---\n\n${piece}` : piece);
    }
  }
  return map;
}

function formatDesignPullForTask(references, snippetByHeading) {
  if (!references?.length) return [];
  const lines = ['- design 원문 발췌 (이 태스크에서 반드시 반영):'];
  for (const ref of references) {
    const sn = snippetByHeading.get(ref);
    if (sn) {
      lines.push(`  - **${ref}**`);
      for (const row of sn.split('\n')) {
        lines.push(`    ${row}`);
      }
    }
  }
  if (lines.length === 1) return [];
  return lines;
}

main().catch((error) => {
  console.error(`\n[MakeGo] ${error.message}`);
  process.exit(1);
});
