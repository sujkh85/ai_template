/**
 * 환경 변수 로더
 * .env 파일이 있으면 .env를, 없으면 .env.example을 자동으로 불러옵니다.
 */

import { existsSync, mkdirSync } from 'fs';
import { config }     from 'dotenv';
import { resolve, join } from 'path';
import { homedir }    from 'os';

const envPath     = resolve(process.cwd(), '.env');
const examplePath = resolve(process.cwd(), '.env.example');

if (existsSync(envPath)) {
  config({ path: envPath });
} else if (existsSync(examplePath)) {
  console.warn('[ENV] .env 파일이 없습니다. .env.example을 기본값으로 사용합니다.');
  config({ path: examplePath });
} else {
  console.warn('[ENV] .env 및 .env.example 파일이 모두 없습니다. 기본값으로 실행됩니다.');
}

const DEFAULT_NPM_CACHE = join(homedir(), '.npm-cache-ai-template');

/**
 * npx / infinite-context MCP 가 깨진 ~/.npm/_cacache 를 건드리지 않도록 할 npm 캐시 디렉터리.
 * 미설정 시 ~/.npm-cache-ai-template 사용.
 *
 * @returns {string}
 */
export function getResolvedNpmCacheDir() {
  const explicit =
    String(process.env.npm_config_cache ?? '').trim()
    || String(process.env.NPM_CONFIG_CACHE ?? '').trim();
  const dir = explicit || DEFAULT_NPM_CACHE;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  process.env.npm_config_cache = dir;
  process.env.NPM_CONFIG_CACHE = dir;
  return dir;
}

getResolvedNpmCacheDir();
