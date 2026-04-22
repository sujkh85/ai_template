import './loadEnv.js';
import fs from 'fs/promises';
import path from 'path';
import { withOllamaFallback, persistInfiniteContextHandoff } from './cliRunner.js';
import { getCliRunner } from './agentConfig.js';

const DEFAULT_GOAL_FILE = './goal.md';
const DEFAULT_OUTPUT_DIR = './design';
const DEFAULT_PLAN_COUNT = 6;
const DEFAULT_CHECKPOINT_FILE = '.make-design-session.json';

async function main() {
  const cwd = process.cwd();
  const goalPath = path.resolve(cwd, process.env.DESIGN_SOURCE_GOAL_FILE ?? process.env.GO_FILE ?? DEFAULT_GOAL_FILE);
  const outputDir = path.resolve(cwd, process.env.DESIGN_DIR ?? DEFAULT_OUTPUT_DIR);
  const checkpointPath = path.resolve(outputDir, DEFAULT_CHECKPOINT_FILE);
  const maxFilesPerSession = Number(process.env.DESIGN_MAX_FILES_PER_SESSION ?? 3);
  const { ai, run } = getCliRunner('design', process.env.DESIGN_AI ?? process.env.WORKER_AI ?? 'claude');
  const continueInProcess = process.env.DESIGN_CONTINUE_IN_PROCESS !== 'false';

  await fs.mkdir(outputDir, { recursive: true });

  const goalContent = await readGoal(goalPath);
  while (true) {
    const session = await runSingleDesignSession({
      goalPath,
      goalContent,
      outputDir,
      checkpointPath,
      maxFilesPerSession,
      run,
      ai,
    });

    if (session.done) {
      return;
    }

    if (!continueInProcess) {
      console.log('[MakeDesign] 컨텍스트 한도 대비를 위해 체크포인트 저장 후 새 세션으로 이어갑니다.');
      launchNextMakeDesignSession();
      return;
    }

    console.log('[MakeDesign] 체크포인트에서 같은 프로세스로 다음 세션을 이어서 실행합니다.');
  }
}

async function runSingleDesignSession({
  goalPath,
  goalContent,
  outputDir,
  checkpointPath,
  maxFilesPerSession,
  run,
  ai,
}) {
  const checkpoint = await readCheckpoint(checkpointPath);

  const plan = checkpoint?.plan?.length
    ? checkpoint.plan
    : await buildDesignPlan({ goalContent, goalPath, run, ai });

  const startIndex = Number(checkpoint?.nextIndex ?? 0);
  const endIndexExclusive = Math.min(startIndex + maxFilesPerSession, plan.length);

  console.log(`[MakeDesign] source: ${goalPath}`);
  console.log(`[MakeDesign] outputDir: ${outputDir}`);
  console.log(`[MakeDesign] ai: ${ai}`);
  console.log(`[MakeDesign] plan count: ${plan.length}`);
  console.log(`[MakeDesign] session range: ${startIndex + 1}..${endIndexExclusive}`);

  for (let i = startIndex; i < endIndexExclusive; i += 1) {
    const item = plan[i];
    const filename = buildNumberedFilename(i + 1, item.filename, item.title);
    const filePath = path.resolve(outputDir, filename);

    const alreadyCreated = await readExistingDesignFiles(outputDir);
    const prompt = buildDesignFilePrompt({
      goalPath,
      goalContent,
      outputDir,
      item,
      index: i + 1,
      alreadyCreated,
    });

    const { text } = await withOllamaFallback(run, ai, prompt);
    const content = normalizeDocument(text) || buildFallbackDesignSection({ goalContent, item, index: i + 1 });

    await fs.writeFile(filePath, content, 'utf-8');
    console.log(`[MakeDesign] written: ${filePath}`);
  }

  const done = endIndexExclusive >= plan.length;

  if (done) {
    await safeUnlink(checkpointPath);
    console.log('[MakeDesign] 모든 design 문서 생성 완료');
    return { done: true };
  }

  await writeCheckpoint(checkpointPath, {
    source: goalPath,
    outputDir,
    plan,
    nextIndex: endIndexExclusive,
    updatedAt: new Date().toISOString(),
    note: 'infinite-context handoff checkpoint',
  });

  await persistInfiniteContextHandoff(
    [
      '[make-design handoff]',
      `source: ${goalPath}`,
      `nextIndex: ${endIndexExclusive}`,
      `total: ${plan.length}`,
      'nextAction: resume make-design and continue remaining design files',
    ].join('\n'),
    {
      stage: 'make-design',
      nextIndex: endIndexExclusive,
      total: plan.length,
    },
  );

  return { done: false };
}

async function readGoal(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`goal.md 파일을 읽을 수 없습니다: ${filePath}\n${error.message}`);
  }
}

async function readCheckpoint(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCheckpoint(filePath, payload) {
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}

function launchNextMakeDesignSession() {
  const nextEntry = path.resolve(process.cwd(), 'src/makeDesign.js');
  const message = [
    '[MakeDesign] 새 프로세스 재시작 경로는 안정성 문제로 기본 비활성화되었습니다.',
    `[MakeDesign] 필요 시 다음 명령으로 수동 재개하세요: ${process.execPath} ${nextEntry}`,
  ].join('\n');
  console.warn(message);
}

async function buildDesignPlan({ goalContent, goalPath, run, ai }) {
  const prompt = [
    '당신은 구현 가능한 상세 설계 문서를 분할하는 아키텍트입니다.',
    'goal.md를 읽고 구현 가능한 수준의 상세 설계 문서 파일 계획을 JSON 배열로 출력하세요.',
    '',
    '반드시 지킬 규칙:',
    '- 출력은 JSON 배열만 허용합니다.',
    '- 각 항목은 { "title": "...", "filename": "...", "focus": "..." } 구조여야 합니다.',
    '- 총 4~10개 항목으로 구성하세요.',
    '- filename은 영문 소문자 kebab-case + .md 형식이어야 합니다.',
    '- title은 한국어로 작성하세요.',
    '- goal.md의 요구사항을 구현 가능한 단위로 나누세요.',
    '',
    `입력 파일: ${goalPath}`,
    '',
    'goal.md 원문:',
    goalContent,
  ].join('\n');

  const { text } = await withOllamaFallback(run, ai, prompt);
  const parsed = parsePlanJson(text);
  if (parsed.length > 0) return parsed;
  return buildFallbackPlan(goalContent);
}

function parsePlanJson(text) {
  const raw = (text ?? '').trim();
  if (!raw) return [];

  const fenced = raw.match(/```(?:json)?\n([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;

  try {
    const arr = JSON.parse(body);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((item) => ({
        title: `${item?.title ?? ''}`.trim(),
        filename: `${item?.filename ?? ''}`.trim(),
        focus: `${item?.focus ?? ''}`.trim(),
      }))
      .filter((item) => item.title);
  } catch {
    return [];
  }
}

function buildFallbackPlan(goalContent) {
  const seeds = extractSectionTitles(goalContent).slice(0, DEFAULT_PLAN_COUNT);
  const base = seeds.length > 0 ? seeds : [
    '프로젝트 개요 및 범위',
    '핵심 사용자 플로우',
    '데이터 모델 및 상태',
    'API 및 인터페이스',
    '화면 설계',
    '테스트 및 운영 계획',
  ];

  return base.map((title, index) => ({
    title,
    filename: `design-${String(index + 1).padStart(2, '0')}.md`,
    focus: `${title}의 구현 상세 설계`,
  }));
}

function extractSectionTitles(markdown) {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^##+\s+/.test(line))
    .map((line) => line.replace(/^##+\s+/, '').replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean);
}

function buildNumberedFilename(index, filename, title) {
  const safe = sanitizeFilename(filename || title || `design-${index}`);
  return `${index}. ${safe}`;
}

function sanitizeFilename(value) {
  const base = String(value)
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9-_\s]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${base || 'design'}.md`;
}

async function readExistingDesignFiles(outputDir) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'));

  const snippets = [];
  for (const name of files.slice(0, 20)) {
    const text = await fs.readFile(path.resolve(outputDir, name), 'utf-8');
    snippets.push(`### ${name}\n${text.slice(0, 1200)}`);
  }
  return snippets.join('\n\n---\n\n');
}

function buildDesignFilePrompt({ goalPath, goalContent, outputDir, item, index, alreadyCreated }) {
  return [
    '당신은 시니어 소프트웨어 아키텍트입니다.',
    'goal.md를 기반으로 개발자가 즉시 구현 가능한 상세 설계 문서를 작성하세요.',
    '',
    '중요 요구사항:',
    '- 이번 출력은 하나의 마크다운 문서 본문만 출력하세요.',
    '- 문서는 반드시 한국어로 작성하세요.',
    '- 내용은 구현 가능한 수준으로 매우 구체적이어야 합니다.',
    '- 섹션마다 입력/출력, 예외 케이스, 수용 기준을 포함하세요.',
    '- 설계 대상 밖의 추측은 "가정"으로 표시하세요.',
    '- 실행 모드는 infinite-context입니다. 컨텍스트가 커지면 핵심 결정을 메모리로 남기고 이어서 작업한다고 가정하고 일관성을 유지하세요.',
    '',
    `입력 파일: ${goalPath}`,
    `출력 파일: ${path.resolve(outputDir, buildNumberedFilename(index, item.filename, item.title))}`,
    `이번 문서 번호: ${index}`,
    `문서 제목: ${item.title}`,
    `문서 초점: ${item.focus || item.title}`,
    '',
    '필수 문서 구조:',
    `# ${index}. ${item.title}`,
    '## 목적과 범위',
    '## 상세 요구사항',
    '## 기능/컴포넌트 설계',
    '## 데이터 계약 (입출력/스키마)',
    '## 예외 및 실패 처리',
    '## 구현 단계 (체크리스트)',
    '## 테스트 기준',
    '## 오픈 이슈',
    '',
    '이미 생성된 design 문서 일부 요약:',
    alreadyCreated || '(없음)',
    '',
    'goal.md 원문:',
    goalContent,
  ].join('\n');
}

function normalizeDocument(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';
  const fenced = trimmed.match(/```(?:md|markdown)?\n([\s\S]*?)```/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function buildFallbackDesignSection({ goalContent, item, index }) {
  const short = goalContent.replace(/\r/g, '').slice(0, 2000);
  return [
    `# ${index}. ${item.title}`,
    '',
    '## 목적과 범위',
    `- 이 문서는 "${item.title}" 구현에 필요한 상세 설계를 제공한다.`,
    `- 초점: ${item.focus || item.title}`,
    '',
    '## 상세 요구사항',
    '- goal.md의 관련 태스크를 기능 단위로 분해한다.',
    '- 각 기능의 성공 조건과 완료 기준을 정의한다.',
    '',
    '## 기능/컴포넌트 설계',
    '- 컴포넌트 경계와 책임을 명시한다.',
    '- 외부 의존성과 연결 지점을 식별한다.',
    '',
    '## 데이터 계약 (입출력/스키마)',
    '- 입력 파라미터, 출력 구조, 검증 규칙을 정의한다.',
    '- 오류 응답 포맷과 메시지 정책을 포함한다.',
    '',
    '## 예외 및 실패 처리',
    '- 실패 시 재시도 정책과 롤백 기준을 정의한다.',
    '- 사용자/운영자 관점의 오류 대응 플로우를 구분한다.',
    '',
    '## 구현 단계 (체크리스트)',
    '- [ ] 핵심 로직 구현',
    '- [ ] 경계 조건 처리',
    '- [ ] 테스트 코드 추가',
    '- [ ] 문서/로그 정리',
    '',
    '## 테스트 기준',
    '- 정상 케이스, 경계 케이스, 실패 케이스를 각각 검증한다.',
    '- 회귀 테스트 기준을 명시한다.',
    '',
    '## 오픈 이슈',
    '- goal.md 기반 추가 상세화가 필요한 항목을 기록한다.',
    '',
    '## 참고 (goal.md 발췌)',
    short,
  ].join('\n');
}

main().catch((error) => {
  console.error(`\n[MakeDesign] ${error.message}`);
  process.exit(1);
});
