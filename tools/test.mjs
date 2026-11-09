// macOS /var and /tmp can be symlinks; fixtures must use the real private temp root.
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
const files = process.argv.slice(2);
const result = spawnSync(process.execPath, ['--test', ...(files.length ? files : fs.readdirSync('test').filter(f => f.endsWith('.test.mjs')).map(f => `test/${f}`))], {
  stdio: 'inherit', shell: false, env: { ...process.env, TMPDIR: fs.realpathSync(os.tmpdir()) },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
