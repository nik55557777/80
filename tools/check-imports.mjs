import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const acorn = require('acorn');
const walk = require('acorn-walk');

function* files(dir) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { if (!/node_modules|\.venv|library/.test(p)) yield* files(p); }
    else if (p.endsWith('.js')) yield p;
  }
}
const mods = new Map();   // abs path -> {exports:Set, default:bool}
const all = [...files('src'), ...files('worklet')];

// pass 1: collect exports
for (const f of all) {
  const src = readFileSync(f, 'utf8');
  let ast; try { ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' }); }
  catch (e) { console.log('PARSE FAIL', f, e.message); continue; }
  const ex = new Set(); let def = false;
  walk.simple(ast, {
    ExportNamedDeclaration(n) {
      if (n.declaration) {
        if (n.declaration.type === 'VariableDeclaration') n.declaration.declarations.forEach(d => d.id.name && ex.add(d.id.name));
        else if (n.declaration.type === 'FunctionDeclaration') ex.add(n.declaration.id.name);
        else if (n.declaration.type === 'ClassDeclaration') ex.add(n.declaration.id.name);
      }
      (n.specifiers || []).forEach(s => ex.add(s.exported.name));
    },
    ExportDefaultDeclaration() { def = true; },
    ExportAllDeclaration(n) { ex.add('*:' + n.source.value); },
  });
  mods.set(path.resolve(f), { exports: ex, default: def, src, ast });
}
// re-export resolution for `export {x} from './y'`
function resolveFrom(file, spec) {
  return path.resolve(path.dirname(file), spec);
}

// pass 2: check imports
let problems = 0;
for (const f of all) {
  const abs = path.resolve(f);
  const m = mods.get(abs); if (!m) continue;
  walk.simple(m.ast, {
    ImportDeclaration(n) {
      const target = resolveFrom(abs, n.source.value);
      const t = mods.get(target);
      if (!t) { console.log('MISSING MODULE', f, '->', n.source.value); problems++; return; }
      for (const s of n.specifiers) {
        if (s.type === 'ImportDefaultSpecifier') {
          if (!t.default) { console.log('NO DEFAULT', f, 'imports default from', n.source.value); problems++; }
        } else if (s.type === 'ImportSpecifier') {
          const name = s.imported.name;
          if (!t.exports.has(name) && ![...t.exports].some(e => e.startsWith('*:'))) {
            console.log('NO EXPORT', f, `imports {${name}} from`, n.source.value, '| has:', [...t.exports].slice(0,8).join(','));
            problems++;
          }
        }
      }
    },
  });
}
console.log(problems ? `\n${problems} import problem(s)` : 'all imports/exports resolve OK');
process.exit(problems ? 1 : 0);
