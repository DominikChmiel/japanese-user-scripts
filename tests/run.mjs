import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = ['wanikani-review-recap.test.mjs', 'bunpro-mistake-recap.test.mjs'];

let failed = 0;
for (const suite of suites) {
  const result = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}

console.log(failed ? `\n${failed} suite(s) failed` : '\nAll suites passed');
process.exit(failed ? 1 : 0);
