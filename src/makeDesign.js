import './loadEnv.js';
import fs from 'fs/promises';
import path from 'path';
import { withOllamaFallback } from './cliRunner.js';
import { getCliRunner } from './agentConfig.js';

const DEFAULT_CONCEPT_FILE = './concept.md';
const DEFAULT_OUTPUT_DIR = './design';
const DEFAULT_OUTPUT_FILE = 'design-plan.md';

async function main() {
  const cwd = process.cwd();
  const conceptPath = path.resolve(cwd, process.env.DESIGN_CONCEPT_FILE ?? DEFAULT_CONCEPT_FILE);
  const outputDir = path.resolve(cwd, process.env.DESIGN_DIR ?? DEFAULT_OUTPUT_DIR);
  const outputFile = path.resolve(outputDir, process.env.DESIGN_OUTPUT_FILE ?? DEFAULT_OUTPUT_FILE);

  const concept = await readConcept(conceptPath);
  const { ai, run } = getCliRunner('design', process.env.DESIGN_AI ?? process.env.WORKER_AI ?? 'claude');

  console.log(`[MakeDesign] concept: ${conceptPath}`);
  console.log(`[MakeDesign] output: ${outputFile}`);
  console.log(`[MakeDesign] ai: ${ai}`);

  const prompt = buildPrompt({ concept, conceptPath, outputFile });
  const { text } = await withOllamaFallback(run, ai, prompt);
  const designDoc = normalizeDocument(text) || buildFallbackDesignDoc(concept);

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(outputFile, designDoc, 'utf-8');

  console.log(`[MakeDesign] written: ${outputFile}`);
}

async function readConcept(filePath) {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`concept.md 파일을 읽을 수 없습니다: ${filePath}\n${error.message}`);
  }
}

function buildPrompt({ concept, conceptPath, outputFile }) {
  return [
    '당신은 서비스 기획자입니다.',
    '아래 concept.md를 읽고 바로 실행 가능한 한국어 기획서를 마크다운으로 작성하세요.',
    '설명 문장 외의 메타 발언은 금지합니다.',
    `입력 파일: ${conceptPath}`,
    `출력 파일: ${outputFile}`,
    '',
    '반드시 아래 구조를 지키세요.',
    '# 서비스명',
    '## 1. 프로젝트 개요',
    '## 2. 문제 정의',
    '## 3. 타깃 사용자',
    '## 4. 핵심 가치 제안',
    '## 5. 사용자 시나리오',
    '## 6. 핵심 기능',
    '## 7. 화면/콘텐츠 기획',
    '## 8. 수익화 또는 운영 전략',
    '## 9. MVP 범위',
    '## 10. 성공 지표',
    '## 11. 리스크와 대응',
    '## 12. 다음 실행 항목',
    '',
    '요구사항:',
    '- concept.md에 없는 내용은 단정하지 말고, 필요한 경우 "가정"으로 표시하세요.',
    '- 각 섹션은 실행 가능한 수준으로 구체적으로 작성하세요.',
    '- 핵심 기능 섹션은 우선순위가 드러나게 표 형태로 작성하세요.',
    '- 화면/콘텐츠 기획에는 최소 5개 화면 또는 콘텐츠 블록을 포함하세요.',
    '- 다음 실행 항목은 체크리스트 형식으로 작성하세요.',
    '',
    'concept.md 원문:',
    concept,
  ].join('\n');
}

function normalizeDocument(text) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';

  const fenced = trimmed.match(/```(?:md|markdown)?\n([\s\S]*?)```/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function buildFallbackDesignDoc(concept) {
  const title = extractTitle(concept);
  const bullets = extractBullets(concept);
  const assumptions = bullets.length > 0 ? bullets : ['구체 요구사항은 concept.md 보강이 필요함'];

  return [
    `# ${title}`,
    '',
    '## 1. 프로젝트 개요',
    `- 목표: ${firstSentence(concept) || '아이디어를 검증 가능한 서비스 기획으로 구체화한다.'}`,
    '- 산출물: MVP 중심의 서비스 기획서 초안',
    '- 참고: AI 생성 실패 시 로컬 템플릿으로 작성된 초안',
    '',
    '## 2. 문제 정의',
    '- 사용자가 해결하려는 핵심 문제를 한 문장으로 다시 정리해야 한다.',
    '- 현재 concept.md에는 시장/경쟁/운영 제약 정보가 제한적일 수 있다.',
    '',
    '## 3. 타깃 사용자',
    '- 1차 타깃: concept.md에서 직접 언급된 핵심 사용자군',
    '- 2차 타깃: 초기 확장 가능성이 있는 인접 사용자군',
    '',
    '## 4. 핵심 가치 제안',
    '- 사용자에게 제공할 가장 강한 효익 1개를 명확히 정의한다.',
    '- 경쟁 대안 대비 더 빠르거나, 더 쉽거나, 더 신뢰할 수 있어야 한다.',
    '',
    '## 5. 사용자 시나리오',
    '1. 사용자가 서비스에 유입된다.',
    '2. 핵심 가치를 이해하고 첫 행동을 수행한다.',
    '3. 결과를 확인하고 재방문 동기를 얻는다.',
    '',
    '## 6. 핵심 기능',
    '| 우선순위 | 기능 | 목적 | 비고 |',
    '| --- | --- | --- | --- |',
    '| P0 | 핵심 문제 해결 기능 | 서비스 존재 이유 검증 | 가정 기반 |',
    '| P0 | 온보딩/입력 흐름 | 첫 사용 이탈 방지 | 가정 기반 |',
    '| P1 | 결과 확인/공유 | 재사용과 확산 유도 | 가정 기반 |',
    '| P1 | 운영자 관리 도구 | 운영 효율 확보 | 가정 기반 |',
    '',
    '## 7. 화면/콘텐츠 기획',
    '- 랜딩/소개 화면: 문제와 핵심 가치를 짧게 전달',
    '- 가입/온보딩 화면: 사용자 정보 및 목적 수집',
    '- 메인 작업 화면: 핵심 기능 실행',
    '- 결과 화면: 성과, 추천 액션, 저장/공유 제공',
    '- 마이페이지 또는 히스토리 화면: 재사용성과 리텐션 확보',
    '- 운영/관리 화면: 데이터 확인 및 콘텐츠 관리',
    '',
    '## 8. 수익화 또는 운영 전략',
    '- 초기에는 사용성 검증이 우선이며, 유료화는 후순위로 둔다.',
    '- 운영 기준, 고객 응대 기준, 콘텐츠 업데이트 기준을 문서화한다.',
    '',
    '## 9. MVP 범위',
    '- 반드시 필요한 흐름만 포함한다.',
    '- 수동 운영으로 대체 가능한 자동화는 후순위로 미룬다.',
    '- 외부 연동은 검증에 꼭 필요한 경우에만 포함한다.',
    '',
    '## 10. 성공 지표',
    '- 방문 대비 핵심 행동 전환율',
    '- 첫 사용 완료율',
    '- 7일 재방문율',
    '- 사용자 피드백의 긍정/부정 비율',
    '',
    '## 11. 리스크와 대응',
    '- 요구사항 불명확: concept.md 상세화 및 인터뷰로 보완',
    '- 가치 제안 약함: 경쟁 대안 대비 차별점 재정의',
    '- 개발 범위 과다: P0/P1 기준으로 MVP 재절단',
    '',
    '## 12. 다음 실행 항목',
    '- [ ] 타깃 사용자와 핵심 문제를 한 문장으로 재정의',
    '- [ ] P0 기능 3개 이내로 MVP 범위 고정',
    '- [ ] 화면 흐름 와이어 초안 작성',
    '- [ ] 데이터/운영 정책 초안 작성',
    '- [ ] go.md에 구현 태스크로 분해',
    '',
    '## 가정',
    ...assumptions.map((item) => `- ${item}`),
  ].join('\n');
}

function extractTitle(markdown) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '서비스 기획서';
}

function firstSentence(text) {
  const cleaned = text.replace(/\r/g, ' ').replace(/\n+/g, ' ').trim();
  if (!cleaned) return '';
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0];
  return sentence.slice(0, 180);
}

function extractBullets(markdown) {
  return markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ''))
    .slice(0, 8);
}

main().catch((error) => {
  console.error(`\n[MakeDesign] ${error.message}`);
  process.exit(1);
});
