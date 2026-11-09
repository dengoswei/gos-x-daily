import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyFiles } from '../deployment/mac/run.mjs';

test('Mac release pins exact source and rejects tampering, traversal, duplicates and symlinks', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mac-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'entry.mjs'), '// synthetic');
  const file = { path: 'entry.mjs', sha256: createHash('sha256').update('// synthetic').digest('hex') };
  assert.equal(verifyFiles(root, { files: [file] }), 1);
  assert.throws(() => verifyFiles(root, { files: [file, file] }), /Invalid/);
  assert.throws(() => verifyFiles(root, { files: [{ ...file, path: '../entry.mjs' }] }), /Invalid/);
  fs.symlinkSync(path.join(root, 'entry.mjs'), path.join(root, 'alias.mjs'));
  assert.throws(() => verifyFiles(root, { files: [{ ...file, path: 'alias.mjs' }] }), /path changed/);
  fs.writeFileSync(path.join(root, 'entry.mjs'), '// changed');
  assert.throws(() => verifyFiles(root, { files: [file] }), /hash changed/);
});
