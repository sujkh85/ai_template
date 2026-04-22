/**
 * 현재 세션 종료 후 새 Node.js 프로세스를 스폰하여 다음 세션을 시작합니다.
 * 새 프로세스는 업데이트된 goal.md를 읽고 남은 태스크를 이어서 실행합니다.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 새 세션을 스폰합니다.
 *
 * @param {object} options
 * @param {number} options.sessionNumber  - 다음 세션 번호
 * @param {number} options.delayMs        - 스폰 전 대기 시간 (ms)
 */
export function launchNextSession({ sessionNumber = 1, delayMs = 2000 } = {}) {
  console.log(`\n[SessionLauncher] ${delayMs / 1000}초 후 세션 ${sessionNumber} 시작...`);

  setTimeout(() => {
    const entryPoint = path.join(__dirname, 'index.js');

    // 환경변수 복사 (HANDOFF_FILE 제거 — goal.md에서 직접 복원)
    const env = { ...process.env };
    delete env.HANDOFF_FILE;

    console.log(`[SessionLauncher] 새 세션 프로세스 시작: node ${entryPoint}`);
    console.log('─'.repeat(60));
    console.log(`  세션 ${sessionNumber} 시작`);
    console.log('─'.repeat(60) + '\n');

    const child = spawn(process.execPath, [entryPoint], {
      cwd: process.cwd(),
      env,
      stdio: 'inherit',   // 같은 터미널에서 출력 공유
      detached: false,    // 부모 프로세스 종료 시 같이 종료
    });

    child.on('error', (err) => {
      console.error(`[SessionLauncher] 새 세션 시작 실패: ${err.message}`);
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[SessionLauncher] 세션 ${sessionNumber} 비정상 종료 (exit ${code})`);
      }
    });

    // 현재 프로세스 종료 (새 프로세스에게 자리 넘김)
    process.exit(0);
  }, delayMs);
}
