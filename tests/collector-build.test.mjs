// A clean checkout commits collector/. The image guard passes on this tree.
// A directory that only has the README still fails the guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const docker = fs.readFileSync(path.join(APP, 'Dockerfile'), 'utf8');
const guard = docker.split('\n').reduce((acc, line, i, all) => acc ?? (line.startsWith('RUN test -f collector/') ? (line + '\n' + all[i + 1]).replace(/^RUN /, '') : null), null);

function runGuard(dir) {
  return spawnSync('sh', ['-c', guard], { cwd: dir, encoding: 'utf8' });
}

const SHIPPED = [
  'upstream/fetch_feed.py', 'live_mesh.py', 'inbox_pass.py', 'deploy_status.py', 'host_poll.py',
  'feed_cap.py', 'next_parent.py', 'ci_inbox.py',
  'fleet-roster.json', 'fleet-nodes.json', 'site.json', 'routing/inbox.py', 'routing/board.py',
  'routing/inbox-roles.json', 'README.md',
];

test('Dockerfile guards collector/ right after copying it', () => {
  assert.ok(guard, 'guard RUN line present');
  assert.ok(docker.indexOf('COPY collector ./collector') < docker.indexOf('RUN test -f collector/'));
  assert.equal(docker.includes('assemble-collector'), false);
});

test('committed collector passes the guard and holds every shipped file', () => {
  for (const f of SHIPPED) {
    assert.ok(fs.existsSync(path.join(APP, 'collector', f)), f);
  }
  const r = runGuard(APP);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(missingLocalImports(path.join(APP, 'collector')), []);
});

test('a collector with only the README fails the guard', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-readme-'));
  fs.mkdirSync(path.join(dir, 'collector'));
  fs.copyFileSync(path.join(APP, 'collector', 'README.md'), path.join(dir, 'collector', 'README.md'));
  const r = runGuard(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing from git/);
});

test('deploy.sh does not assemble or railway up', () => {
  const text = fs.readFileSync(path.join(APP, 'deploy.sh'), 'utf8');
  assert.doesNotMatch(text, /assemble-collector/);
  assert.doesNotMatch(text, /railway up/);
  assert.equal(spawnSync('bash', [path.join(APP, 'deploy.sh')], { encoding: 'utf8' }).status, 1);
});

test('owner-name is the committed house name', () => {
  assert.equal(fs.readFileSync(path.join(APP, 'owner-name'), 'utf8'), 'owner\n');
});

function missingLocalImports(collectorDir) {
  const script = [
    'import ast, json, sys',
    'from pathlib import Path',
    'root = Path(sys.argv[1]).resolve()',
    'stdlib = set(sys.stdlib_module_names)',
    'stems = {p.stem for p in root.rglob("*.py")}',
    'missing = []',
    'for path in sorted(root.rglob("*.py")):',
    '    tree = ast.parse(path.read_text())',
    '    for node in ast.walk(tree):',
    '        names = []',
    '        if isinstance(node, ast.Import):',
    '            names = [a.name.split(".")[0] for a in node.names]',
    '        elif isinstance(node, ast.ImportFrom):',
    '            if node.level:',
    '                base = path.parent',
    '                for _ in range(node.level - 1):',
    '                    base = base.parent',
    '                mods = [node.module] if node.module else [a.name for a in node.names]',
    '                for mod in mods:',
    '                    cand = base.joinpath(*mod.split("."))',
    '                    if not (cand.with_suffix(".py").is_file() or (cand / "__init__.py").is_file()):',
    '                        missing.append(f"{path.relative_to(root)}:{mod}")',
    '                continue',
    '            if node.module:',
    '                names = [node.module.split(".")[0]]',
    '        else:',
    '            continue',
    '        for name in names:',
    '            if name in stdlib or name in stems:',
    '                continue',
    '            missing.append(f"{path.relative_to(root)}:{name}")',
    'print(json.dumps(sorted(set(missing))))',
  ].join('\n');
  const r = spawnSync('python3', ['-c', script, collectorDir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
