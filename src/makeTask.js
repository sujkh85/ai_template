import './loadEnv.js';
import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import { withOllamaFallback, persistInfiniteContextHandoff } from './cliRunner.js';
import { runDbSaveTask } from './dbSaveTask.js';
import { getCliRunner } from './agentConfig.js';

const DEFAULT_DESIGN_DIR = './design';
const DEFAULT_TASK_DIR = './task';
const DEFAULT_TASK_GLOB = '**/*.md';
const DEFAULT_CHECKPOINT_FILE = '.make-task-session.json';
const DEFAULT_GOAL_FILE = './goal.md';

async function main() {
  const cwd = process.cwd();
  const goalPath = path.resolve(cwd, process.env.GO_FILE ?? DEFAULT_GOAL_FILE);
  const designDir = path.resolve(cwd, process.env.DESIGN_DIR ?? DEFAULT_DESIGN_DIR);
  const taskDir = path.resolve(cwd, process.env.TASK_DIR ?? DEFAULT_TASK_DIR);
  const pattern = process.env.DESIGN_GLOB ?? DEFAULT_TASK_GLOB;
  const maxChars = Number(process.env.TASK_SOURCE_MAX_CHARS ?? 200_000);
  const maxFilesPerSession = Number(process.env.TASK_MAX_FILES_PER_SESSION ?? 3);
  const checkpointPath = path.resolve(taskDir, DEFAULT_CHECKPOINT_FILE);
  const { ai, run } = getCliRunner('task', process.env.TASK_AI ?? process.env.WORKER_AI ?? 'claude');

  await fs.mkdir(taskDir, { recursive: true });
  const goalContent = await readGoal(goalPath);
  const designDocs = await loadDesignDocs({ designDir, pattern, maxChars });
  console.log(`[MakeTask] goal: ${goalPath}`);
  console.log(`[MakeTask] design: ${designDir}`);
  console.log(`[MakeTask] task: ${taskDir}`);
  console.log(`[MakeTask] ai: ${ai}`);
  console.log(`[MakeTask] docs: ${designDocs.length}`);

  while (true) {
    const checkpoint = await readCheckpoint(checkpointPath);
    const startIndex = Number(checkpoint?.nextIndex ?? 0);
    const endIndexExclusive = Math.min(startIndex + maxFilesPerSession, designDocs.length);
    console.log(`[MakeTask] session range: ${startIndex + 1}..${endIndexExclusive}`);

    for (let index = startIndex; index < endIndexExclusive; index += 1) {
      const doc = designDocs[index];
      const taskNumber = index + 1;
      const outputName = buildTaskFileName(taskNumber, doc.path);
      const outputPath = path.resolve(taskDir, outputName);
      const qualityHints = buildDesignQualityHints(doc.content);

      const prompt = buildTaskPrompt({
        goalPath,
        goalContent,
        designPath: doc.path,
        designContent: doc.content,
        taskNumber,
        outputPath,
        qualityHints,
      });

      const { text } = await withOllamaFallback(run, ai, prompt);
      const normalized = normalizeDocument(text);
      const taskDoc = pickBestTaskDoc({
        generatedDoc: normalized,
        taskNumber,
        designPath: doc.path,
        designContent: doc.content,
        qualityHints,
      });

      await fs.writeFile(outputPath, taskDoc, 'utf-8');
      console.log(`[MakeTask] written: ${outputPath}`);
    }

    const done = endIndexExclusive >= designDocs.length;
    if (done) {
      await safeUnlink(checkpointPath);
      console.log('[MakeTask] task 문서 생성 완료');
      await runDbSaveTask();
      return;
    }

    await writeCheckpoint(checkpointPath, {
      designDir,
      taskDir,
      nextIndex: endIndexExclusive,
      total: designDocs.length,
      updatedAt: new Date().toISOString(),
      note: 'infinite-context handoff checkpoint',
    });

    await persistInfiniteContextHandoff(
      [
        '[make-task handoff]',
        `designDir: ${designDir}`,
        `taskDir: ${taskDir}`,
        `nextIndex: ${endIndexExclusive}`,
        `total: ${designDocs.length}`,
        'nextAction: resume make-task and continue remaining task files',
      ].join('\n'),
      {
        stage: 'make-task',
        nextIndex: endIndexExclusive,
        total: designDocs.length,
      },
    );

    console.log('[MakeTask] 체크포인트 저장 후 같은 세션에서 다음 범위를 이어서 처리합니다.');
  }
}

async function loadDesignDocs({ designDir, pattern, maxChars }) {
  const stat = await fs.stat(designDir).catch((error) => {
    throw new Error(`design 폴더를 찾을 수 없습니다: ${designDir}\n${error.message}`);
  });
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

  const docs = [];
  for (const relative of sorted) {
    const fullPath = path.join(designDir, relative);
    let content = await fs.readFile(fullPath, 'utf-8');
    if (content.length > maxChars) {
      content = `${content.slice(0, maxChars)}\n\n(문서 길이 제한으로 일부만 사용됨)`;
    }
    docs.push({
      path: relative.split(path.sep).join('/'),
      content,
    });
  }
  return docs;
}

async function readGoal(goalPath) {
  try {
    return await fs.readFile(goalPath, 'utf-8');
  } catch (error) {
    throw new Error(`goal.md 파일을 읽을 수 없습니다: ${goalPath}\n${error.message}`);
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

function buildTaskFileName(taskNumber, designPath) {
  const base = path.basename(designPath, '.md').replace(/^\d+\.\s*/, '').trim();
  const normalizedBase = base.replace(/^design(?=[\s-_]|$)/i, 'task');
  const slug = String(base)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-_]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const normalizedSlug = String(normalizedBase)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-_]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const finalSlug = normalizedSlug || slug;
  return `${taskNumber}. ${finalSlug || `task-${taskNumber}`}.md`;
}

function buildTaskPrompt({ goalPath, goalContent, designPath, designContent, taskNumber, outputPath, qualityHints }) {
  return [
    '당신은 design 문서를 실행 태스크로 분해하는 시니어 플래너입니다.',
    '입력된 goal.md + design 문서의 도메인에 맞춰 즉시 실행 가능한 작업(task) md 문서를 작성하세요.',
    '',
    '강제 규칙:',
    '- 결과물은 markdown 본문만 출력하세요.',
    '- 반드시 한국어로 작성하세요.',
    '- 작업 에이전트가 즉시 실행 가능한 수준으로 구체화하세요.',
    '- 추상적인 문장 대신 design 문서의 도메인 단위(예: 장면/설정 또는 컴포넌트/로직)와 검증 기준으로 작성하세요.',
    '- 각 작업에 완료 조건(DoD)과 검증 방법을 포함하세요.',
    '- design 문서에 없는 내용은 단정하지 말고 "가정"으로 표시하세요.',
    '- "어디를 수정할지 알 수 없는 추상 태스크"를 금지합니다.',
    '- design의 각 핵심 항목을 하나 이상의 실행 태스크로 추적 가능하게 매핑하세요.',
    '- goal.md의 컨셉/톤/우선순위와 충돌하는 태스크를 만들지 마세요.',
    '- 태스크는 최소 6개 이상 작성하세요.',
    '- 각 태스크마다 반드시 다음 6줄을 포함하세요: 작업 내용 / 변경 대상 / 산출물 / 완료 조건(DoD) / 검증 방법 / 실패 시 대응.',
    '',
    `입력 goal 파일: ${goalPath}`,
    `입력 design 파일: ${designPath}`,
    `출력 task 파일: ${outputPath}`,
    `task 문서 번호: ${taskNumber}`,
    '',
    '문서 구조:',
    `# ${taskNumber}. 실행 태스크 - ${designPath}`,
    '## 목적',
    '## 선행 조건',
    '## Design 추적 매트릭스',
    '| design 항목 | 실행 태스크 | 검증 기준 |',
    '| --- | --- | --- |',
    '## 실행 태스크 목록',
    '### 태스크 1: ...',
    '- 작업 내용',
    '- 변경 대상',
    '- 산출물',
    '- 완료 조건(DoD)',
    '- 검증 방법',
    '- 실패 시 대응',
    '## 리스크와 대응',
    '## 오픈 이슈',
    '',
    'design 핵심 항목 힌트:',
    qualityHints,
    '',
    'goal.md 원문:',
    goalContent,
    '',
    'design 문서 원문:',
    designContent,
  ].join('\n');
}

function normalizeDocument(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';
  const fenced = trimmed.match(/```(?:md|markdown)?\n([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : trimmed).trim();
  if (!body.startsWith('#')) return '';
  return body;
}

function pickBestTaskDoc({ generatedDoc, taskNumber, designPath, designContent, qualityHints }) {
  const parsedDesign = parseDesignToTaskInputs(designContent);
  const fallback = buildFallbackTask({
    taskNumber,
    designPath,
    designContent,
    parsedDesign,
    qualityHints,
  });

  if (!generatedDoc) return fallback;
  const quality = evaluateTaskQuality(generatedDoc);
  if (quality.passed) return generatedDoc;
  return fallback;
}

function evaluateTaskQuality(taskDoc) {
  const mustHaveHeadings = [
    '## 목적',
    '## 선행 조건',
    '## Design 추적 매트릭스',
    '## 실행 태스크 목록',
    '## 리스크와 대응',
    '## 오픈 이슈',
  ];
  const headingScore = mustHaveHeadings.filter((heading) => taskDoc.includes(heading)).length;
  const taskCount = (taskDoc.match(/^###\s+태스크\s+\d+:/gm) || []).length;
  const detailFields = ['- 작업 내용', '- 변경 대상', '- 산출물', '- 완료 조건(DoD)', '- 검증 방법', '- 실패 시 대응'];
  const detailScore = detailFields.filter((field) => taskDoc.includes(field)).length;

  return {
    passed: headingScore >= mustHaveHeadings.length && taskCount >= 6 && detailScore >= detailFields.length,
  };
}

function parseDesignToTaskInputs(designContent) {
  const sections = extractSections(designContent);
  const taskSeeds = [];
  const sourceOrder = [
    '상세 요구사항',
    '기능/컴포넌트 설계',
    '데이터 계약 (입출력/스키마)',
    '예외 및 실패 처리',
    '테스트 기준',
    '기본 컨셉',
    '주인공 설정',
    '세계관 설정',
    '서술 방식',
    '줄거리 방향성',
    '집필 스타일 요청',
  ];

  for (const key of sourceOrder) {
    const lines = sections[key] || [];
    for (const line of lines) {
      const cleaned = line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim();
      if (!cleaned) continue;
      if (cleaned.length < 8) continue;
      taskSeeds.push({ source: key, text: cleaned });
      if (taskSeeds.length >= 12) break;
    }
    if (taskSeeds.length >= 12) break;
  }

  return {
    sections,
    taskSeeds,
  };
}

function extractSections(markdown) {
  const lines = String(markdown ?? '').replace(/\r/g, '').split('\n');
  const sections = {};
  let current = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      current = heading[1].trim();
      sections[current] = sections[current] || [];
      continue;
    }
    if (!current) continue;
    if (!line) continue;
    sections[current].push(line);
  }
  return sections;
}

function buildDesignQualityHints(designContent) {
  const parsed = parseDesignToTaskInputs(designContent);
  if (!parsed.taskSeeds.length) {
    return '- 추출 가능한 항목이 제한적이므로 섹션별 최소 1개 태스크를 직접 보강하세요.';
  }
  return parsed.taskSeeds
    .slice(0, 8)
    .map((seed, idx) => `${idx + 1}. [${seed.source}] ${seed.text}`)
    .join('\n');
}

function buildFallbackTask({ taskNumber, designPath, designContent, parsedDesign, qualityHints }) {
  const excerpt = designContent.slice(0, 3000);
  const seeds = parsedDesign.taskSeeds.length
    ? parsedDesign.taskSeeds
    : [{ source: '상세 요구사항', text: 'design 원문에서 실행 요구사항을 재추출한다.' }];
  const taskLines = seeds.slice(0, 8).map((seed, index) => {
    const taskIndex = index + 1;
    return [
      `### 태스크 ${taskIndex}: ${seed.source} 반영 - ${seed.text.slice(0, 36)}`,
      `- 작업 내용: design의 "${seed.text}" 항목을 실행 가능한 단위로 쪼개어 반영한다.`,
      '- 변경 대상: 관련 문서/프롬프트/로직/초안 등 도메인별 산출물 (파일 경로는 현재 저장소 기준으로 확정).',
      `- 산출물: ${seed.source} 항목을 반영한 업데이트 결과물과 변경 내역`,
      '- 완료 조건(DoD): 해당 design 항목의 요구가 태스크 결과물에서 누락 없이 확인된다.',
      '- 검증 방법: design 원문 항목과 결과물을 1:1 체크리스트로 대조한다.',
      '- 실패 시 대응: 누락 항목을 오픈 이슈로 기록하고 다음 태스크에서 우선 보완한다.',
      '',
    ].join('\n');
  }).join('\n');

  const matrixLines = seeds.slice(0, 8).map((seed, index) => (
    `| ${seed.source}: ${seed.text.slice(0, 40)} | 태스크 ${index + 1} | design 항목 대조 체크 통과 |`
  ));

  return [
    `# ${taskNumber}. 실행 태스크 - ${designPath}`,
    '',
    '## 목적',
    '- design 문서를 실행 단계로 분해해 작업 에이전트가 즉시 실행할 수 있도록 한다.',
    '',
    '## 선행 조건',
    '- 관련 design 문서를 끝까지 읽고 범위를 확정한다.',
    '- 기존 산출물/규칙/맥락과 충돌 가능성을 확인한다.',
    '',
    '## Design 추적 매트릭스',
    '| design 항목 | 실행 태스크 | 검증 기준 |',
    '| --- | --- | --- |',
    ...matrixLines,
    '',
    '## 실행 태스크 목록',
    taskLines,
    '',
    '## 리스크와 대응',
    '- 리스크: design 문서의 모호한 항목',
    '- 대응: 가정 명시 후 추후 확정 포인트 기록',
    '',
    '## 오픈 이슈',
    '- 추가 확인이 필요한 항목을 작업 진행 중 업데이트한다.',
    '',
    '## 참고 (design 발췌)',
    excerpt,
    '',
    '## 생성 힌트 로그',
    qualityHints || '- 없음',
  ].join('\n');
}

main().catch((error) => {
  console.error(`\n[MakeTask] ${error.message}`);
  process.exit(1);
});
