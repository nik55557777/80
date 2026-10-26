import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const src = await readFile(f, 'utf8');
  try {
    new vm.SourceTextModule(src, { identifier: f });
    console.log('  ok  ', f);
  } catch (e) {
    bad++;
    console.log(' FAIL ', f, '\n       ', e.message);
  }
}
process.exit(bad ? 1 : 0);
