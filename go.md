# FocusFlow — 정보 구조와 데이터 흐름 설계

## 프로젝트 개요
- design 폴더의 문서를 기준으로 구현용 실행 문서를 생성한다.
- 세부 내용이 부족한 부분은 구현 중 가정으로 명시하고 문서를 보완한다.

## 구현 목표
- 핵심 사용자 흐름을 구현 가능한 단위로 나눈다.
- MVP 범위를 먼저 완성하고 이후 확장 요소를 분리한다.

## 작업 원칙
- design 문서의 요구사항을 우선한다.
- 모호한 요구사항은 임의 확장보다 보수적으로 구현한다.
- 각 태스크 완료 시 지정된 완료 문구를 그대로 출력한다.

## 참고 문서
- data-flow.md
- design-plan.md
- requirements.md

## 태스크 목록
### 태스크 1: 요구사항 정리와 구현 범위 확정
- design 문서의 핵심 요구사항과 제약사항을 정리한다.
- MVP 범위와 후순위 범위를 구분한다.
- 참고 섹션: 화면 연결 구조, 데이터 모델
- design 원문 발췌 (이 태스크에서 반드시 반영):
  - **화면 연결 구조**
    **data-flow.md**
    ```
    [온보딩 화면]
        │ 핵심 작업 입력 완료
        ▼
    [메인 작업 화면]
        │ 완료 버튼 클릭
        ▼
    [완료/회고 화면]
        │ 회고 제출
        ▼
    [메인 작업 화면] (다음 날 재시작 또는 당일 종료)
    ```
    
    ### 화면 전환 조건
    
    | 현재 화면 | 전환 조건 | 다음 화면 |
    |----------|----------|----------|
    | 온보딩 | 핵심 작업 입력 + 확정 | 메인 작업 |
    | 메인 작업 | 타이머 완료 + 완료 버튼 | 완료/회고 |
    | 완료/회고 | 회고 제출 | 메인 작업 (성취 메시지 표시 후) |
    
    ### 앱 초기 진입 라우팅
    
    ```
    앱 시작
        │
        ├─ localStorage에 오늘 날짜의 task가 없음 → [온보딩 화면]
        │
        ├─ task.status === 'pending' 또는 'in-progress' → [메인 작업 화면]
        │
        └─ task.status === 'completed' → [완료/회고 화면] (성취 메시지 표시)
    ```
    
    ---
  - **데이터 모델**
    **data-flow.md**
    ### TodayTask (localStorage 저장)
    
    ```typescript
    interface TodayTask {
      id: string;                           // uuid
      date: string;                         // "YYYY-MM-DD"
      title: string;                        // 오늘의 핵심 작업 1개
      estimatedMinutes: number;             // 예상 소요 시간 (분)
      distractions: string;                 // 예상 방해 요소 메모
      status: 'pending' | 'in-progress' | 'completed';
      startedAt: number | null;             // timestamp (ms)
      completedAt: number | null;           // timestamp (ms)
      actualMinutes: number | null;         // 실제 소요 시간 (분)
      retrospective: string | null;         // 완료 후 한 줄 회고
    }
    ```
    
    ### TimerState (UI 상태, 메모리)
    
    ```typescript
    interface TimerState {
      isRunning: boolean;
      elapsedSeconds: number;
      startTimestamp: number | null;        // 마지막 시작 시각 (ms)
      pausedElapsed: number;                // 일시정지 전 누적 시간 (초)
    }
    ```
    
    ### AppState (UI 전역 상태)
    
    ```typescript
    interface AppState {
      screen: 'onboarding' | 'main' | 'complete';
      isFirstVisit: boolean;                // 온보딩 안내 표시 여부
      todayTask: TodayTask | null;
      timer: TimerState;
    }
    ```
    
    ---
- 완료 시 응답: "태스크 1 완료"

### 태스크 2: 정보 구조와 데이터 흐름 설계
- 핵심 화면과 기능 사이의 연결 구조를 정리한다.
- 필요한 데이터 모델과 상태 흐름을 정의한다.
- 참고 섹션: 상태 흐름, localStorage 스키마
- design 원문 발췌 (이 태스크에서 반드시 반영):
  - **상태 흐름**
    **data-flow.md**
    ### 온보딩 → 메인 작업
    
    ```
    사용자 입력:
      title (필수), estimatedMinutes (필수), distractions (선택)
        │
        ▼
    TodayTask 생성
      { id, date: 오늘, title, estimatedMinutes, distractions,
        status: 'pending', startedAt: null, ... }
        │
        ▼
    localStorage.setItem('focusflow_task', JSON.stringify(task))
        │
        ▼
    screen → 'main'
    ```
    
    ### 메인 작업: 타이머 상태 전환
    
    ```
    [대기 상태: status=pending]
        │ 시작 버튼
        ▼
    [실행 중: status=in-progress, timer.isRunning=true]
        │ 일시정지 버튼
        ▼
    [일시정지: status=in-progress, timer.isRunning=false]
        │ 재시작 버튼
        ▼
    [실행 중] ...반복...
        │ 완료 버튼
        ▼
    [완료 전환: status=completed, completedAt=now, actualMinutes=elapsed]
        │
        ▼
    screen → 'complete'
    ```
    
    ### 완료/회고 → 저장
    
    ```
    사용자 입력: retrospective (선택)
        │
        ▼
    TodayTask 업데이트
      { retrospective, completedAt }
        │
        ▼
    localStorage 갱신
        │
        ▼
    성취 메시지 표시 → screen → 'main' (다음 날 작업 대기)
    ```
    
    ---
  - **localStorage 스키마**
    **data-flow.md**
    | 키 | 값 | 설명 |
    |----|----|----|
    | `focusflow_task` | `TodayTask JSON` | 오늘의 작업 (날짜 기준 1개) |
    | `focusflow_visited` | `"true"` | 첫 방문 여부 (온보딩 스킵용) |
    
    ### 날짜 교체 로직
    
    ```
    앱 시작 시:
      저장된 task.date !== 오늘 날짜
        → 기존 task 아카이브 (또는 삭제)
        → 온보딩 화면으로 이동
    ```
    
    ---
- 완료 시 응답: "태스크 2 완료"

### 태스크 3: 핵심 사용자 흐름 구현
- 사용자의 첫 진입부터 핵심 행동 완료까지의 흐름을 구현한다.
- 주요 입력, 결과, 피드백 동선을 반영한다.
- 참고 섹션: 핵심 이벤트 목록, 가정
- design 원문 발췌 (이 태스크에서 반드시 반영):
  - **핵심 이벤트 목록**
    **data-flow.md**
    | 이벤트 | 트리거 | 결과 |
    |--------|--------|------|
    | TASK_CREATED | 온보딩 확정 | TodayTask 생성, localStorage 저장 |
    | TIMER_STARTED | 시작 버튼 | isRunning=true, startedAt 기록 |
    | TIMER_PAUSED | 일시정지 버튼 | isRunning=false, pausedElapsed 누적 |
    | TIMER_RESUMED | 재시작 버튼 | isRunning=true, startTimestamp 갱신 |
    | TASK_COMPLETED | 완료 버튼 | status=completed, actualMinutes 저장 |
    | RETRO_SUBMITTED | 회고 제출 | retrospective 저장, 성취 메시지 표시 |
    
    ---
  - **가정**
    **data-flow.md**
    - 사용자 인증 없음 — localStorage 기반으로 단일 기기에서 동작
    - 타이머는 Pomodoro 방식 아닌 자유 시간 측정 (시작/일시정지/완료)
    - 하루 1개 핵심 작업만 저장 — 날짜가 바뀌면 새 작업으로 초기화
    - 히스토리 저장은 P1 — MVP에서는 오늘 작업만 유지
    
    ---
    
    **design-plan.md**
    - 기존 투두 앱은 기능이 많지만 실제 실행까지 이어지지 않는 경우가 많다.
    - 사용자는 계획보다 실행 압박과 짧은 피드백을 원한다.
    - 모바일과 데스크톱 어디서든 빠르게 확인할 수 있어야 한다.
    - 해야 할 일은 많지만 우선순위를 자주 놓치는 직장인
    - 공부 계획은 세우지만 끝까지 실행하기 어려운 대학생/취준생
    - 복잡한 프로젝트 툴보다 가벼운 집중 도구를 원하는 1인 창작자
    - 사용자가 하루 계획을 너무 많이 세워 오히려 시작을 못 한다.
    - 중요한 일보다 쉬운 일을 먼저 처리하며 만족감을 소비한다.
    
    ---
    
    **requirements.md**
    - 사용자 계정 시스템은 MVP에서 로컬 스토리지로 대체 가능 (인증 없이 시작)
    - 타이머는 Pomodoro 방식이 아닌 자유 시간 측정 방식으로 구현
    - 모바일 우선 반응형 웹으로 구현 (네이티브 앱 제외)
- 완료 시 응답: "태스크 3 완료"

### 태스크 4: 우선순위 기능 완성
- P0 기능을 우선 구현하고 문서와 동작을 맞춘다.
- 가정이 필요한 부분은 최소화하고 코드에 반영한다.
- 참고 섹션: 프로젝트 개요, 문제 정의
- design 원문 발췌 (이 태스크에서 반드시 반영):
  - **프로젝트 개요**
    **design-plan.md**
    - 목표: # FocusFlow ## 컨셉 한 줄 할 일을 많이 적는 앱이 아니라, 오늘 반드시 끝내야 할 일 1개에 집중하게 만드는 개인 생산성 서비스.
    - 산출물: MVP 중심의 서비스 기획서 초안
    - 참고: AI 생성 실패 시 로컬 템플릿으로 작성된 초안
  - **문제 정의**
    **design-plan.md**
    - 사용자가 해결하려는 핵심 문제를 한 문장으로 다시 정리해야 한다.
    - 현재 concept.md에는 시장/경쟁/운영 제약 정보가 제한적일 수 있다.
- 완료 시 응답: "태스크 4 완료"

### 태스크 5: 검증과 문서 정리
- 주요 기능 동작을 점검하고 누락된 요구사항을 확인한다.
- 변경된 내용과 남은 작업을 문서에 정리한다.
- 참고 섹션: 화면 연결 구조, 데이터 모델, 상태 흐름, localStorage 스키마, 핵심 이벤트 목록, 가정, 프로젝트 개요, 문제 정의
- design 원문 발췌 (이 태스크에서 반드시 반영):
  - **화면 연결 구조**
    **data-flow.md**
    ```
    [온보딩 화면]
        │ 핵심 작업 입력 완료
        ▼
    [메인 작업 화면]
        │ 완료 버튼 클릭
        ▼
    [완료/회고 화면]
        │ 회고 제출
        ▼
    [메인 작업 화면] (다음 날 재시작 또는 당일 종료)
    ```
    
    ### 화면 전환 조건
    
    | 현재 화면 | 전환 조건 | 다음 화면 |
    |----------|----------|----------|
    | 온보딩 | 핵심 작업 입력 + 확정 | 메인 작업 |
    | 메인 작업 | 타이머 완료 + 완료 버튼 | 완료/회고 |
    | 완료/회고 | 회고 제출 | 메인 작업 (성취 메시지 표시 후) |
    
    ### 앱 초기 진입 라우팅
    
    ```
    앱 시작
        │
        ├─ localStorage에 오늘 날짜의 task가 없음 → [온보딩 화면]
        │
        ├─ task.status === 'pending' 또는 'in-progress' → [메인 작업 화면]
        │
        └─ task.status === 'completed' → [완료/회고 화면] (성취 메시지 표시)
    ```
    
    ---
  - **데이터 모델**
    **data-flow.md**
    ### TodayTask (localStorage 저장)
    
    ```typescript
    interface TodayTask {
      id: string;                           // uuid
      date: string;                         // "YYYY-MM-DD"
      title: string;                        // 오늘의 핵심 작업 1개
      estimatedMinutes: number;             // 예상 소요 시간 (분)
      distractions: string;                 // 예상 방해 요소 메모
      status: 'pending' | 'in-progress' | 'completed';
      startedAt: number | null;             // timestamp (ms)
      completedAt: number | null;           // timestamp (ms)
      actualMinutes: number | null;         // 실제 소요 시간 (분)
      retrospective: string | null;         // 완료 후 한 줄 회고
    }
    ```
    
    ### TimerState (UI 상태, 메모리)
    
    ```typescript
    interface TimerState {
      isRunning: boolean;
      elapsedSeconds: number;
      startTimestamp: number | null;        // 마지막 시작 시각 (ms)
      pausedElapsed: number;                // 일시정지 전 누적 시간 (초)
    }
    ```
    
    ### AppState (UI 전역 상태)
    
    ```typescript
    interface AppState {
      screen: 'onboarding' | 'main' | 'complete';
      isFirstVisit: boolean;                // 온보딩 안내 표시 여부
      todayTask: TodayTask | null;
      timer: TimerState;
    }
    ```
    
    ---
  - **상태 흐름**
    **data-flow.md**
    ### 온보딩 → 메인 작업
    
    ```
    사용자 입력:
      title (필수), estimatedMinutes (필수), distractions (선택)
        │
        ▼
    TodayTask 생성
      { id, date: 오늘, title, estimatedMinutes, distractions,
        status: 'pending', startedAt: null, ... }
        │
        ▼
    localStorage.setItem('focusflow_task', JSON.stringify(task))
        │
        ▼
    screen → 'main'
    ```
    
    ### 메인 작업: 타이머 상태 전환
    
    ```
    [대기 상태: status=pending]
        │ 시작 버튼
        ▼
    [실행 중: status=in-progress, timer.isRunning=true]
        │ 일시정지 버튼
        ▼
    [일시정지: status=in-progress, timer.isRunning=false]
        │ 재시작 버튼
        ▼
    [실행 중] ...반복...
        │ 완료 버튼
        ▼
    [완료 전환: status=completed, completedAt=now, actualMinutes=elapsed]
        │
        ▼
    screen → 'complete'
    ```
    
    ### 완료/회고 → 저장
    
    ```
    사용자 입력: retrospective (선택)
        │
        ▼
    TodayTask 업데이트
      { retrospective, completedAt }
        │
        ▼
    localStorage 갱신
        │
        ▼
    성취 메시지 표시 → screen → 'main' (다음 날 작업 대기)
    ```
    
    ---
  - **localStorage 스키마**
    **data-flow.md**
    | 키 | 값 | 설명 |
    |----|----|----|
    | `focusflow_task` | `TodayTask JSON` | 오늘의 작업 (날짜 기준 1개) |
    | `focusflow_visited` | `"true"` | 첫 방문 여부 (온보딩 스킵용) |
    
    ### 날짜 교체 로직
    
    ```
    앱 시작 시:
      저장된 task.date !== 오늘 날짜
        → 기존 task 아카이브 (또는 삭제)
        → 온보딩 화면으로 이동
    ```
    
    ---
  - **핵심 이벤트 목록**
    **data-flow.md**
    | 이벤트 | 트리거 | 결과 |
    |--------|--------|------|
    | TASK_CREATED | 온보딩 확정 | TodayTask 생성, localStorage 저장 |
    | TIMER_STARTED | 시작 버튼 | isRunning=true, startedAt 기록 |
    | TIMER_PAUSED | 일시정지 버튼 | isRunning=false, pausedElapsed 누적 |
    | TIMER_RESUMED | 재시작 버튼 | isRunning=true, startTimestamp 갱신 |
    | TASK_COMPLETED | 완료 버튼 | status=completed, actualMinutes 저장 |
    | RETRO_SUBMITTED | 회고 제출 | retrospective 저장, 성취 메시지 표시 |
    
    ---
  - **가정**
    **data-flow.md**
    - 사용자 인증 없음 — localStorage 기반으로 단일 기기에서 동작
    - 타이머는 Pomodoro 방식 아닌 자유 시간 측정 (시작/일시정지/완료)
    - 하루 1개 핵심 작업만 저장 — 날짜가 바뀌면 새 작업으로 초기화
    - 히스토리 저장은 P1 — MVP에서는 오늘 작업만 유지
    
    ---
    
    **design-plan.md**
    - 기존 투두 앱은 기능이 많지만 실제 실행까지 이어지지 않는 경우가 많다.
    - 사용자는 계획보다 실행 압박과 짧은 피드백을 원한다.
    - 모바일과 데스크톱 어디서든 빠르게 확인할 수 있어야 한다.
    - 해야 할 일은 많지만 우선순위를 자주 놓치는 직장인
    - 공부 계획은 세우지만 끝까지 실행하기 어려운 대학생/취준생
    - 복잡한 프로젝트 툴보다 가벼운 집중 도구를 원하는 1인 창작자
    - 사용자가 하루 계획을 너무 많이 세워 오히려 시작을 못 한다.
    - 중요한 일보다 쉬운 일을 먼저 처리하며 만족감을 소비한다.
    
    ---
    
    **requirements.md**
    - 사용자 계정 시스템은 MVP에서 로컬 스토리지로 대체 가능 (인증 없이 시작)
    - 타이머는 Pomodoro 방식이 아닌 자유 시간 측정 방식으로 구현
    - 모바일 우선 반응형 웹으로 구현 (네이티브 앱 제외)
  - **프로젝트 개요**
    **design-plan.md**
    - 목표: # FocusFlow ## 컨셉 한 줄 할 일을 많이 적는 앱이 아니라, 오늘 반드시 끝내야 할 일 1개에 집중하게 만드는 개인 생산성 서비스.
    - 산출물: MVP 중심의 서비스 기획서 초안
    - 참고: AI 생성 실패 시 로컬 템플릿으로 작성된 초안
  - **문제 정의**
    **design-plan.md**
    - 사용자가 해결하려는 핵심 문제를 한 문장으로 다시 정리해야 한다.
    - 현재 concept.md에는 시장/경쟁/운영 제약 정보가 제한적일 수 있다.
- 완료 시 응답: "태스크 5 완료"