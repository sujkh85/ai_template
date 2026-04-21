/**
 * 환경 변수 로더
 * .env 파일이 있으면 .env를, 없으면 .env.example을 자동으로 불러옵니다.
 */

import { existsSync } from 'fs';
import { config }     from 'dotenv';
import { resolve }    from 'path';

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
