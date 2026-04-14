# auto-agent-template

> `go.md`를 읽고 토큰이 소진될 때까지 자율 실행하는 멀티 에이전트 템플릿

`go.md`에 작업 지시서를 작성하면, LangGraph 기반 멀티 에이전트가 태스크를 자동으로 실행합니다. 컨텍스트 한도에 도달하면 진행 상황을 저장하고 새 세션으로 자동 재시작하여 작업을 끊김 없이 이어갑니다.

---

## 특징

- **go.md 기반 실행** — 마크다운 파일에 태스크를 정의하면 에이전트가 자동으로 파싱하여 순서대로 실행
- **멀티 에이전트 파이프라인** — Supervisor가 다음 실행 에이전트를 결정하고, Worker가 실제 태스크를 처리
- **자동 세션 재시작** — 컨텍스트 토큰 한도 도달 시 진행 상황을 go.md에 기록하고 새 Node 프로세스로 자동 재개
- **AI 조합 선택** — Supervisor와 Worker에 각각 `claude`, `gemini`, `codex` 중 원하는 AI 지정 가능
- **Ollama 폴백** — CLI 호출 실패 시 로컬 Ollama 모델로 자동 전환

---

## 프로젝트 구조

```
template/
├── src/
│   ├── index.js          # 진입점 — 세션 관리 및 그래프 실행
│   ├── graph.js          # LangGraph 워크플로우 정의
│   ├── agentConfig.js    # AI CLI 설정 관리
│   ├── goReader.js       # go.md 파싱 (태스크, 완료 상태 추출)
│   ├── goWriter.js       # 세션 결과를 go.md에 기록
│   ├── sessionLauncher.js # 새 세션 프로세스 스폰
│   ├── contextMonitor.js # 토큰 사용량 추적
│   ├── handoff.js        # 핸드오프 파일 생성
│   ├── cliRunner.js      # Claude / Gemini / Codex CLI 호출
│   └── agents/
│       ├── supervisor.js # Supervisor 에이전트 노드
│       └── workerAgent.js # Worker 에이전트 노드
├── go.md                 # 작업 지시서 (직접 수정)
├── .env                  # 환경 설정 (복사 후 수정)
├── .env.example          # 환경 설정 예시
└── package.json
```

---

## 시작하기

### 1. AI CLI 설치 (필수)

이 템플릿은 AI CLI 도구를 직접 호출합니다. 사용할 AI에 맞는 CLI를 **반드시** 설치하고 로그인해 두어야 합니다.

| AI | CLI 설치 |
|----|----------|
| Claude | [claude.ai/code](https://claude.ai/code) — Claude Code CLI 설치 후 `claude` 명령어 사용 가능 확인 |
| Gemini | [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) — `npm install -g @google/gemini-cli` 후 `gemini` 명령어 사용 가능 확인 |
| Codex | [OpenAI Codex CLI](https://github.com/openai/codex) — `npm install -g @openai/codex` 후 `codex` 명령어 사용 가능 확인 |

> `.env`에서 `SUPERVISOR_AI`와 `WORKER_AI`에 지정한 AI의 CLI만 설치되어 있으면 됩니다.  
> 예를 들어 `SUPERVISOR_AI=gemini`, `WORKER_AI=claude`이면 `gemini`와 `claude` CLI만 있으면 됩니다.

설치 후 각 CLI가 정상 동작하는지 확인하세요.

```bash
claude --version
gemini --version
codex --version
```

### 2. 의존성 설치

```bash
npm install
# 또는
pnpm install
```

### 3. 환경 설정

```bash
cp .env.example .env
```

`.env`를 열어 사용할 AI를 설정합니다.

```env
SUPERVISOR_AI=gemini   # supervisor에 사용할 AI (claude | gemini | codex)
WORKER_AI=claude       # worker에 사용할 AI (claude | gemini | codex)
```

### 4. go.md 작성

`go.md`에 프로젝트 개요와 태스크를 작성합니다.

```markdown
# 프로젝트 이름

## 프로젝트 개요
무엇을 만들지 설명하세요.

## 태스크 목록

### 태스크 1: 첫 번째 작업
- 해야 할 일을 작성하세요
- 완료 시 출력: "태스크1 완료"

### 태스크 2: 두 번째 작업
- 해야 할 일을 작성하세요
- 완료 시 출력: "태스크2 완료"
```

> **태스크 파싱 규칙**
> - `### 태스크명` 형식의 헤더를 태스크로 인식합니다.
> - `###`이 없으면 `##` 헤더를 태스크로 사용합니다.
> - 에이전트가 `"태스크N 완료"` 키워드를 출력하면 해당 태스크가 완료 처리됩니다.

### 5. 실행

```bash
npm start
```

---

## 실행 흐름

```
npm start
  └─ go.md 읽기 (태스크 파싱 + 완료 상태 복원)
       └─ LangGraph 실행
            ├─ Supervisor → 다음 실행할 Worker 결정
            ├─ Worker → 태스크 실행
            ├─ ContextGate → 토큰 한도 확인
            │    ├─ 한도 미달 → Supervisor로 반환
            │    └─ 한도 초과 → Handoff 트리거
            └─ 모든 태스크 완료 → 종료
  └─ go.md에 결과 기록 (완료/미완료 태스크, 세션 로그)
  └─ AUTO_RESTART=true이면 새 세션 자동 시작
```

세션 완료 후 `go.md` 하단에 진행 상황과 세션 로그가 자동으로 기록됩니다. 다음 세션은 이를 읽어 완료된 태스크를 건너뛰고 남은 태스크부터 이어서 실행합니다.

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `SUPERVISOR_AI` | `gemini` | Supervisor 에이전트 AI (`claude` \| `gemini` \| `codex`) |
| `WORKER_AI` | `claude` | Worker 에이전트 AI (`claude` \| `gemini` \| `codex`) |
| `GO_FILE` | `./go.md` | 읽을 go.md 파일 경로 |
| `AUTO_RESTART` | `true` | 세션 종료 후 자동으로 새 세션 시작 여부 |
| `OPEN_NEW_WINDOW` | `true` | Windows에서 자동 재시작 시 새 콘솔 창으로 실행 여부 |
| `CONTINUOUS_MODE` | `false` | 모든 태스크 완료 후 처음부터 반복 여부 |
| `WORKER_ITERATIONS` | `1` | Worker 에이전트 반복 횟수 |
| `RECURSION_LIMIT` | `5000` | LangGraph 재귀 한도 (무한 루프 방지) |
| `CLI_TIMEOUT_MS` | `600000` | CLI 호출 최대 대기 시간 (ms, 기본 10분) |
| `CONTEXT_THRESHOLD` | `0.8` | 핸드오프 트리거 토큰 사용률 (0.0 ~ 1.0) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama 서버 URL (CLI 폴백용) |
| `OLLAMA_MODEL` | `gemma3:12b` | Ollama 사용 모델 |
| `VERBOSE` | `true` | 상세 로그 출력 여부 |

---

## AUTO_RESTART 동작 방식

| 상황 | `AUTO_RESTART=true` | `AUTO_RESTART=false` |
|------|---------------------|----------------------|
| 컨텍스트 한도 도달 | go.md 저장 후 새 세션 자동 시작 | go.md 저장 후 종료 |
| 태스크 미완료 상태 종료 | 새 세션 자동 시작 | 종료 (수동 재시작 필요) |
| 모든 태스크 완료 | 종료 | 종료 |

`AUTO_RESTART=false`인 경우, 남은 태스크가 있으면 `npm start`를 다시 실행하면 이어서 진행됩니다.

---

## 의존성

| 패키지 | 역할 |
|--------|------|
| `@langchain/core` | LangChain 코어 메시지 타입 |
| `@langchain/langgraph` | 멀티 에이전트 워크플로우 그래프 |
| `dotenv` | 환경 변수 로드 |
| `glob` | 파일 탐색 |
| `zod` | 스키마 검증 |
