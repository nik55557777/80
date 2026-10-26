import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const acorn = require('acorn');
let bad = 0;
for (const f of process.argv.slice(2)) {
  try { acorn.parse(readFileSync(f, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch (e) { bad++; console.log('FAIL', f, `line ${e.loc?.line}:${e.loc?.column}`, e.message);
    const L = readFileSync(f,'utf8').split('\n'); console.log('   >', L[e.loc.line-1]); }
}
console.log(bad ? `${bad} file(s) with syntax errors` : 'all files parse OK');
process.exit(bad ? 1 : 0);
