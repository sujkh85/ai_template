# Auto Agent Template (Infinite Context)

Korean and English README for the current codebase.

---

## 한국어 안내

### 1) 프로젝트 소개

이 프로젝트는 **infinite-context MCP 기반 자율 실행 템플릿**입니다.  
핵심은 다음과 같습니다.

- `agent.md` + `requirements.md` + task 문맥을 합쳐 Worker에게 전달
- `Supervisor -> Worker` LangGraph 루프로 태스크를 계속 실행
- 컨텍스트 한도 접근 시 handoff/재시작으로 장기 작업 유지
- 설계/태스크 문서를 생성하고(`make-design`, `make-task`), 메모리에 저장(`db-save-task`)한 뒤 실행(`start`)

---

### 2) 핵심 실행 명령어

```bash
pnpm install
```

```bash
pnpm make-design
pnpm make-task
pnpm db-save-task
pnpm start
```

한 번에 실행:

```bash
pnpm go
```

`pnpm go`는 아래 순서로 실행됩니다.

1. `make-design`
2. `make-task`
3. `db-save-task`
4. `start`

---

### 3) 빠른 시작

1. `.env.example`을 복사해서 `.env` 생성
2. `goal.md`, `agent.md`, `requirements.md` 준비
3. 필요한 경우 AI CLI 로그인(예: `agent login`, `gh auth login`)
4. `pnpm go` 실행

---

### 4) 실행 흐름

1. `make-design`  
   - `goal.md`를 읽어 `design/*.md` 설계 문서 생성
   - 세션당 생성 수 제한(`DESIGN_MAX_FILES_PER_SESSION`) 및 체크포인트 지원

2. `make-task`  
   - `design/*.md`를 읽어 `task/*.md` 실행 태스크 문서 생성
   - 세션당 생성 수 제한(`TASK_MAX_FILES_PER_SESSION`) 및 체크포인트 지원

3. `db-save-task`  
   - `task/*.md`를 infinite-context 메모리에 저장 시도
   - MCP 조회 실패 대비로 `task/.task-memory-export.json` 백업 저장

4. `start`  
   - `Supervisor -> Worker -> contextGate` 그래프 실행
   - task-doc 메모리를 우선 조회하고, 없으면 로컬 백업 사용
   - 남은 태스크가 있으면 `AUTO_RESTART=true`일 때 다음 세션 자동 시작

---

### 5) 주요 환경 변수

전체는 `.env.example` 참고, 자주 쓰는 항목만 요약:

- 실행/AI
  - `SUPERVISOR_AI` (`claude | gemini | codex | agent | copilot`)
  - `WORKER_AI`
  - `EXECUTION_MODE` (기본: `infinite-context`)
- 입력/출력 경로
  - `AGENT_FILE`, `REQUIREMENTS_FILE`, `GO_FILE`
  - `DESIGN_DIR`, `TASK_DIR`
- 자동 실행 제어
  - `AUTO_RESTART` (기본 `true`)
  - `CONTINUOUS_MODE` (모든 태스크 완료 후 반복 여부)
  - `WORKER_ITERATIONS`
  - `ENFORCE_TEST_COMPLETION`
- 컨텍스트/한도
  - `CONTEXT_THRESHOLD` (기본 `0.75`)
  - `CLAUDE_CONTEXT_LIMIT`, `GEMINI_CONTEXT_LIMIT`, `CODEX_CONTEXT_LIMIT` 등
- 폴백
  - `OLLAMA_URL`, `OLLAMA_MODEL`

---

### 6) 프로젝트 구조

```text
.
├─ agent.md
├─ requirements.md
├─ goal.md
├─ .env.example
├─ package.json
├─ design/
├─ task/
└─ src/
   ├─ index.js               # 메인 실행 엔트리
   ├─ graph.js               # LangGraph 구성
   ├─ agents/
   │  ├─ supervisor.js       # 다음 노드 결정
   │  └─ workerAgent.js      # 실제 태스크 실행
   ├─ cliRunner.js           # CLI 실행 + Ollama 폴백 + MCP 메모리 연동
   ├─ makeDesign.js          # goal -> design 문서 생성
   ├─ makeTask.js            # design -> task 문서 생성
   ├─ dbSaveTask.js          # task 문서 메모리 저장
   ├─ designBundle.js        # design 문서 자동 주입
   ├─ contextMonitor.js      # 토큰 사용량 추적
   ├─ handoff.js             # handoff 파일 생성
   ├─ sessionLauncher.js     # 다음 세션 프로세스 실행
   ├─ loadEnv.js             # .env/.env.example 로드
   ├─ goalReader.js
   └─ goalWriter.js
```

---

### 7) 운영 팁

- `task-doc` 메모리 조회가 비어도 로컬 백업(`.task-memory-export.json`)으로 이어서 실행됩니다.
- 컨텍스트 한도 기반 핸드오프를 쓰려면 각 모델의 `*_CONTEXT_LIMIT` 값을 지정하세요.
- `CONTINUOUS_MODE=true`면 모든 태스크 완료 후 처음부터 다시 순환합니다.

---

### 8) 문제 해결

- `design 폴더를 찾을 수 없습니다`  
  -> `DESIGN_DIR` 경로 확인 또는 먼저 `pnpm make-design` 실행

- `task 문서가 없습니다`  
  -> `pnpm make-task`를 먼저 실행했는지 확인

- CLI 실행 실패 후 빈 응답  
  -> 해당 CLI 로그인/권한 상태 확인, `OLLAMA_URL`/`OLLAMA_MODEL` 점검

---

## English Guide

### 1) Overview

This is an **autonomous agent template powered by infinite-context MCP**.

Key behavior:

- Combines `agent.md`, `requirements.md`, and runtime task context for workers
- Runs a LangGraph loop (`Supervisor -> Worker`) until tasks are completed
- Uses handoff/restart when context usage gets high
- Supports planning pipeline (`make-design`, `make-task`, `db-save-task`) before runtime execution

---

### 2) Core Commands

```bash
pnpm install
```

```bash
pnpm make-design
pnpm make-task
pnpm db-save-task
pnpm start
```

Run everything in one shot:

```bash
pnpm go
```

Execution order of `pnpm go`:

1. `make-design`
2. `make-task`
3. `db-save-task`
4. `start`

---

### 3) Quick Start

1. Copy `.env.example` to `.env`
2. Prepare `goal.md`, `agent.md`, and `requirements.md`
3. Sign in to required CLIs (for example `agent login`, `gh auth login`)
4. Run `pnpm go`

---

### 4) Runtime Flow

1. `make-design`  
   - Reads `goal.md` and generates `design/*.md`
   - Supports per-session file limits and checkpoints

2. `make-task`  
   - Reads `design/*.md` and generates executable `task/*.md`
   - Supports per-session file limits and checkpoints

3. `db-save-task`  
   - Stores `task/*.md` into infinite-context memory
   - Also writes a local backup to `task/.task-memory-export.json`

4. `start`  
   - Runs the `Supervisor -> Worker -> contextGate` graph
   - Loads task-docs from memory first, then falls back to local backup
   - Auto-restarts into the next session when `AUTO_RESTART=true` and work remains

---

### 5) Important Environment Variables

See `.env.example` for full details. Commonly used:

- AI/runtime
  - `SUPERVISOR_AI` (`claude | gemini | codex | agent | copilot`)
  - `WORKER_AI`
  - `EXECUTION_MODE` (default: `infinite-context`)
- Paths
  - `AGENT_FILE`, `REQUIREMENTS_FILE`, `GO_FILE`
  - `DESIGN_DIR`, `TASK_DIR`
- Execution control
  - `AUTO_RESTART` (default `true`)
  - `CONTINUOUS_MODE`
  - `WORKER_ITERATIONS`
  - `ENFORCE_TEST_COMPLETION`
- Context limits
  - `CONTEXT_THRESHOLD` (default `0.75`)
  - `CLAUDE_CONTEXT_LIMIT`, `GEMINI_CONTEXT_LIMIT`, `CODEX_CONTEXT_LIMIT`, etc.
- Fallback
  - `OLLAMA_URL`, `OLLAMA_MODEL`

---

### 6) Project Structure

```text
.
├─ agent.md
├─ requirements.md
├─ goal.md
├─ .env.example
├─ package.json
├─ design/
├─ task/
└─ src/
   ├─ index.js
   ├─ graph.js
   ├─ agents/
   │  ├─ supervisor.js
   │  └─ workerAgent.js
   ├─ cliRunner.js
   ├─ makeDesign.js
   ├─ makeTask.js
   ├─ dbSaveTask.js
   ├─ designBundle.js
   ├─ contextMonitor.js
   ├─ handoff.js
   ├─ sessionLauncher.js
   ├─ loadEnv.js
   ├─ goalReader.js
   └─ goalWriter.js
```

---

### 7) Operational Notes

- If memory lookup returns no task-docs, runtime still continues using local backup.
- To enable threshold-based handoff, define model context limits (`*_CONTEXT_LIMIT`).
- With `CONTINUOUS_MODE=true`, completed task sets are reset and execution loops again.

---

### 8) Troubleshooting

- `design folder not found`  
  -> Check `DESIGN_DIR` or run `pnpm make-design` first.

- `no task documents`  
  -> Run `pnpm make-task` before `pnpm db-save-task` or `pnpm start`.

- CLI failure / empty output after fallback  
  -> Verify CLI auth, and check `OLLAMA_URL` / `OLLAMA_MODEL`.
# auto-agent-template

## English

> A multi-agent template for autonomous execution with `infinite-context` memory.

This template is focused on `agent.md + requirements.md + infinite-context MCP` execution.  
When context reaches its threshold, it saves progress and automatically restarts in a new session to continue work without interruption.

---

## Features

- **infinite-context mode** — use `agent.md`/`requirements.md` as runtime instructions with MCP-first long-running memory flow
- **Multi-agent pipeline** — Supervisor chooses next action and Worker executes tasks
- **Automatic session restart** — resumes work after context-limit handoff
- **Flexible AI pairings** — choose `claude`, `gemini`, or `codex` per role
- **Ollama fallback** — automatically fallback to local Ollama when CLI fails

---

## Project Structure

```text
template/
├── src/
│   ├── index.js
│   ├── graph.js
│   ├── agentConfig.js
│   ├── goalReader.js
│   ├── goalWriter.js
│   ├── sessionLauncher.js
│   ├── contextMonitor.js
│   ├── handoff.js
│   ├── cliRunner.js
│   └── agents/
│       ├── supervisor.js
│       └── workerAgent.js
├── goal.md
├── agent.md
├── requirements.md
├── .env
├── .env.example
└── package.json
```

---

## Quick Start

### 1) Install AI CLIs

Install and authenticate only the CLIs you plan to use in `.env`:

- Claude CLI: [claude.ai/code](https://claude.ai/code)
- Gemini CLI: [Google Gemini CLI](https://github.com/google-gemini/gemini-cli)
- Codex CLI: [OpenAI Codex CLI](https://github.com/openai/codex)

Check:

```bash
claude --version
gemini --version
codex --version
```

### 2) Install dependencies

```bash
npm install
# or
pnpm install
```

### 3) Configure environment

```bash
cp .env.example .env
```

### 4) Configure execution mode

```env
EXECUTION_MODE=infinite-context
AGENT_FILE=./agent.md
REQUIREMENTS_FILE=./requirements.md
AUTO_RESTART=true
```

### 5) Run

```bash
npm start
```

---

## MCP (`infinite-context`) Setup

`infinite-context` is not tied to a specific tool.  
Register it in your MCP client/server configuration (whatever environment you use).

Example:

```json
{
  "mcpServers": {
    "infinite-context": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "infinite-context"]
    }
  }
}
```

Then reload MCP servers (or restart the client) and verify `infinite-context` is available.

Tip: add explicit rules in `agent.md` and prompts to prioritize MCP memory usage.

---

## Runtime Flow

```text
npm start
  └─ Check execution mode (infinite-context)
       └─ Load agent.md + requirements.md (MCP-first guidance)
       └─ LangGraph execution
            ├─ Supervisor decides next worker step
            ├─ Worker executes task
            ├─ ContextGate checks limits
            │    ├─ below threshold → back to Supervisor
            │    └─ above threshold → trigger handoff
            └─ finish when work is done
  └─ If AUTO_RESTART=true, start next session automatically
```

---

## Environment Variables

| Variable | Default | Description |
|------|--------|------|
| `EXECUTION_MODE` | `infinite-context` | Execution mode (`infinite-context`) |
| `SUPERVISOR_AI` | `gemini` | Supervisor AI (`claude` \| `gemini` \| `codex`) |
| `WORKER_AI` | `claude` | Worker AI (`claude` \| `gemini` \| `codex`) |
| `GO_FILE` | `./goal.md` | goal file path |
| `AGENT_FILE` | `./agent.md` | Agent instruction file for `infinite-context` mode |
| `REQUIREMENTS_FILE` | `./requirements.md` | Requirements file for `infinite-context` mode |
| `AUTO_RESTART` | `true` | Auto-start next session after cycle ends |
| `CONTINUOUS_MODE` | `false` | Restart from first task after all tasks complete |
| `WORKER_ITERATIONS` | `1` | Worker iterations per task |
| `RECURSION_LIMIT` | `5000` | LangGraph recursion limit |
| `CLI_TIMEOUT_MS` | `600000` | CLI timeout in ms |
| `CONTEXT_THRESHOLD` | `0.9` | Handoff trigger threshold (0.0 ~ 1.0) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `gemma3:12b` | Ollama model name |
| `VERBOSE` | `true` | Verbose logs |

---

## Dependencies

| Package | Purpose |
|--------|------|
| `@langchain/core` | LangChain core message types |
| `@langchain/langgraph` | Multi-agent workflow graph |
| `dotenv` | Load environment variables |
| `glob` | File discovery |
| `zod` | Schema validation |

---

## 한국어

> `infinite-context` 메모리를 기반으로 자율 실행하는 멀티 에이전트 템플릿

`agent.md + requirements.md + infinite-context MCP` 기반 실행에 집중합니다. 컨텍스트 한도에 도달하면 진행 상황을 저장하고 새 세션으로 자동 재시작하여 작업을 끊김 없이 이어갑니다.

---

## 특징

- **infinite-context 기반 실행** — `agent.md`/`requirements.md`를 런타임 지시로 사용하고, MCP 메모리 우선으로 장기 작업 지속
- **멀티 에이전트 파이프라인** — Supervisor가 다음 실행 에이전트를 결정하고, Worker가 실제 태스크를 처리
- **자동 세션 재시작** — 컨텍스트 토큰 한도 도달 시 핸드오프를 기록하고 새 Node 프로세스로 자동 재개
- **AI 조합 선택** — Supervisor와 Worker에 각각 `claude`, `gemini`, `codex`, `agent`, `copilot` 중 원하는 AI 지정 가능
- **Ollama 폴백** — CLI 호출 실패 시 로컬 Ollama 모델로 자동 전환
- **goal → design → task** — `goal.md`를 기반으로 `make-design` / `make-task`로 기획서와 실행 태스크 문서를 자동 생성할 수 있음

---

## 프로젝트 구조

```
template/
├── src/
│   ├── index.js           # 진입점 — 세션 관리 및 그래프 실행
│   ├── graph.js           # LangGraph 워크플로우 정의
│   ├── agentConfig.js     # AI CLI 설정 관리
│   ├── goalReader.js      # goal.md 파싱 (태스크, 완료 상태 추출)
│   ├── goalWriter.js      # 세션 결과를 goal.md에 기록
│   ├── designBundle.js    # DESIGN_DIR 마크다운을 go 컨텍스트에 병합
│   ├── makeDesign.js      # concept.md → design/ 기획 문서
│   ├── makeTask.js        # design/*.md → task/*.md
│   ├── loadEnv.js         # 환경 변수 로드
│   ├── sessionLauncher.js # 새 세션 프로세스 스폰
│   ├── contextMonitor.js  # 토큰 사용량 추적
│   ├── handoff.js         # 핸드오프 파일 생성
│   ├── cliRunner.js       # Claude / Gemini / Codex CLI 호출
│   └── agents/
│       ├── supervisor.js  # Supervisor 에이전트 노드
│       └── workerAgent.js # Worker 에이전트 노드
├── concept.md             # 아이디어·컨셉 입력 (make-design 입력)
├── design/                # 기획 마크다운 (make-design 출력, 런타임 참조)
├── goal.md                # 작업 지시서 입력
├── task/                  # 실행 태스크 마크다운 (make-task 출력)
├── .env                   # 환경 설정 (복사 후 수정)
├── .env.example           # 환경 설정 예시
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
| Cursor Agent | Cursor CLI 설치 후 `agent login` 완료, `agent` 명령어 사용 가능 확인 |
| GitHub Copilot CLI | `gh auth login` 후 `gh extension install github/gh-copilot` 완료, `gh copilot` 사용 가능 확인 |

> `.env`에서 `SUPERVISOR_AI`와 `WORKER_AI`에 지정한 AI의 CLI만 설치되어 있으면 됩니다.  
> 예를 들어 `SUPERVISOR_AI=gemini`, `WORKER_AI=claude`이면 `gemini`와 `claude` CLI만 있으면 됩니다.

설치 후 각 CLI가 정상 동작하는지 확인하세요.

```bash
claude --version
gemini --version
codex --version
agent --version
gh copilot --help
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
SUPERVISOR_AI=gemini   # supervisor에 사용할 AI (claude | gemini | codex | agent | copilot)
WORKER_AI=claude       # worker에 사용할 AI (claude | gemini | codex | agent | copilot)

# (선택) design 폴더의 markdown 파일을 goal.md 뒤에 자동 주입
DESIGN_DIR=./design
# DESIGN_GLOB=**/*.md
# DESIGN_MAX_CHARS_PER_FILE=200000
```

### 4. 기획에서 실행까지 (권장 플로우)

수동으로 `goal.md`를 쓰지 않고, 컨셉만으로 파이프라인을 탈 수 있습니다.

1. 루트에 `concept.md`를 작성합니다.
2. 기획서 생성: `pnpm make-design` → 기본적으로 `design/design-plan.md`가 생성됩니다.
3. 태스크 문서 생성: `pnpm make-task` → `task/*.md`가 생성됩니다. (design 폴더의 `**/*.md`를 읽어 실행 가능한 업무로 세분화)
4. 에이전트 실행: `pnpm start` 또는 `pnpm dev`
5. 한 번에 실행: `pnpm go` → `make-design → make-task → db-save-task → start`를 순차 실행합니다.

`pnpm dev`는 `src` 코드 변경 시 프로세스를 다시 띄우는 **개발용 워치**이고, 태스크를 이어서 돌리는 **세션 재시작**은 주로 `AUTO_RESTART`와 `goal.md` 자동 기록에 의해 이루어집니다.

### 5. goal.md 작성 (수동으로 쓸 때)

`goal.md`에 프로젝트 개요와 태스크를 작성합니다.

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
> - Worker가 **goal.md에 맞춘 완료 문구**를 출력하면 해당 태스크가 완료 처리됩니다. 번호 태스크는 `태스크1 완료` 또는 `태스크 1 완료`처럼 공백이 있어도 인식합니다.

### 6. 실행

```bash
pnpm start
# 또는
npm start
```

### 6. MCP(infinite-context) 강제 사용 설정

`infinite-context` MCP는 특정 도구에만 묶이지 않습니다.  
사용 중인 에이전트/클라이언트 환경의 **MCP 서버 설정**에 `infinite-context`를 등록하면 동일하게 사용할 수 있습니다.

1) 사용 중인 MCP 설정 파일에 서버 등록

- 아래는 설정 예시입니다(파일 경로/형식은 사용하는 환경에 맞게 적용).

```json
{
  "mcpServers": {
    "infinite-context": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "infinite-context"]
    }
  }
}
```

2) 설정 반영
- 사용 중인 클라이언트에서 MCP 서버를 다시 로드하거나 앱을 재시작합니다.
- MCP 서버 목록에 `infinite-context`가 표시되는지 확인합니다.

3) 실제 사용 강제 팁
- `agent.md` 같은 에이전트 지시 파일에 "메모리/컨텍스트 관련 작업은 `infinite-context` MCP를 우선 사용" 규칙을 명시합니다.
- 프롬프트에도 "가능한 경우 MCP 우선" 문구를 넣어 일관되게 동작하도록 합니다.

### 7. infinite-context 자율주행 모드 사용

`agent.md + requirements.md`를 기반으로 장기 세션 자율주행을 하려면 아래처럼 설정합니다.

1) `.env` 설정

```env
EXECUTION_MODE=infinite-context
AGENT_FILE=./agent.md
REQUIREMENTS_FILE=./requirements.md
AUTO_RESTART=true
```

2) 실행

```bash
npm start
```

3) 동작 방식
- `agent.md`/`requirements.md`를 런타임 지시로 사용합니다.
- Worker 반복 횟수(`WORKER_ITERATIONS`)만으로 태스크를 완료 처리하지 않고, 실제 완료 신호가 있을 때만 완료로 간주합니다.
- 컨텍스트 임계치 도달 시 기존처럼 핸드오프 후 다음 세션으로 이어집니다.
- 세션 연속성은 `infinite-context` MCP 메모리 흐름 기준으로 이어집니다.

---

## 실행 흐름

```
npm start
  └─ 실행 모드 확인 (infinite-context)
       └─ agent.md + requirements.md 로드 (MCP 메모리 우선 지시)
       └─ LangGraph 실행
            ├─ Supervisor → 다음 실행할 Worker 결정
            ├─ Worker → 태스크 실행
            ├─ ContextGate → 토큰 한도 확인
            │    ├─ 한도 미달 → Supervisor로 반환
            │    └─ 한도 초과 → Handoff 트리거
            └─ 모든 태스크 완료 → 종료
  └─ AUTO_RESTART=true이면 새 세션 자동 시작
```

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `EXECUTION_MODE` | `infinite-context` | 실행 모드 (`infinite-context`) |
| `SUPERVISOR_AI` | `gemini` | Supervisor 에이전트 AI (`claude` \| `gemini` \| `codex` \| `agent` \| `copilot`) |
| `WORKER_AI` | `claude` | Worker 에이전트 AI (`claude` \| `gemini` \| `codex` \| `agent` \| `copilot`) |
| `GO_FILE` | `./goal.md` | `make-design` 입력 파일 경로 |
| `AGENT_FILE` | `./agent.md` | `infinite-context` 모드에서 읽을 에이전트 지시 파일 |
| `REQUIREMENTS_FILE` | `./requirements.md` | `infinite-context` 모드에서 읽을 요구사항 파일 |
| `DESIGN_DIR` | `./design` | 기획 MD 출력 폴더(`make-design`)이자, 실행 시 goal.md 뒤에 주입할 루트(비우면 주입 비활성) |
| `DESIGN_GLOB` | `**/*.md` | `DESIGN_DIR` 하위에서 주입·수집할 마크다운 패턴 |
| `DESIGN_MAX_CHARS_PER_FILE` | `200000` | 파일당 최대 주입 문자 수 |
| `DESIGN_CONCEPT_FILE` | `./concept.md` | `make-design` 입력 파일 |
| `DESIGN_OUTPUT_FILE` | `design-plan.md` | `make-design`이 `DESIGN_DIR` 안에 쓰는 파일명 |
| `DESIGN_AI` | (미설정 시 `WORKER_AI`) | `make-design`에 쓰는 CLI |
| `TASK_DIR` | `./task` | `make-task` 출력 폴더 |
| `TASK_AI` | (미설정 시 `WORKER_AI`) | `make-task`에 쓰는 CLI |
| `TASK_SOURCE_MAX_CHARS` | `200000` | `make-task`에서 design 문서 파일당 최대 입력 길이 |
| `AUTO_RESTART` | `true` | 세션 종료 후 자동으로 새 세션 시작 여부 |
| `CONTINUOUS_MODE` | `false` | 모든 태스크 완료 후 처음부터 반복 여부 |
| `WORKER_ITERATIONS` | `1` | Worker 에이전트 반복 횟수 |
| `RECURSION_LIMIT` | `5000` | LangGraph 재귀 한도 (무한 루프 방지) |
| `CLI_TIMEOUT_MS` | `600000` | CLI 호출 최대 대기 시간 (ms, 기본 10분) |
| `CONTEXT_THRESHOLD` | `0.9` | 핸드오프 트리거 토큰 사용률 (0.0 ~ 1.0) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama 서버 URL (CLI 폴백용) |
| `OLLAMA_MODEL` | `gemma3:12b` | Ollama 사용 모델 |
| `HANDOFF_FILE` | `` | 이전 세션 핸드오프 파일 경로 (재시작 시 지정) |
| `HANDOFF_DIR` | `./handoff` | 핸드오프 파일 저장 디렉터리 |
| `VERBOSE` | `true` | 상세 로그 출력 여부 |
| `CLAUDE_CONTEXT_LIMIT` | (unset) | Claude 모델 최대 컨텍스트 토큰 한도 |
| `GEMINI_CONTEXT_LIMIT` | (unset) | Gemini 모델 최대 컨텍스트 토큰 한도 |
| `CODEX_CONTEXT_LIMIT` | (unset) | Codex 모델 최대 컨텍스트 토큰 한도 |
| `AGENT_CONTEXT_LIMIT` | (unset) | Agent 모델 최대 컨텍스트 토큰 한도 |
| `COPILOT_CONTEXT_LIMIT` | (unset) | Copilot 모델 최대 컨텍스트 토큰 한도 |
| `OLLAMA_CONTEXT_LIMIT` | (unset) | Ollama 모델 최대 컨텍스트 토큰 한도 |

---

## AUTO_RESTART 동작 방식

| 상황 | `AUTO_RESTART=true` | `AUTO_RESTART=false` |
|------|---------------------|----------------------|
| 컨텍스트 한도 도달 | goal.md 저장 후 새 세션 자동 시작 | goal.md 저장 후 종료 |
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
