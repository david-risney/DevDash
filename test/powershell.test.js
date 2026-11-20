import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../devdash.ps1', import.meta.url));
const hasPowerShell = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0;

function run(script, args, { cwd, env = process.env, input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-File', script, ...args], { cwd, env, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devdash pwsh ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['bin', 'packages/cr', 'node_modules/.bin', 'tools', 'caller']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const script = join(root, 'devdash.ps1');
  await copyFile(launcher, script);
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
  await writeFile(join(root, 'packages', 'cr', 'package.json'), JSON.stringify({ dependencies: {} }));
  await writeFile(join(root, 'node_modules', '.bin', 'cr.cmd'), '@exit /b 0\r\n');
  await writeFile(join(root, 'bin', 'devdash.js'), `
const fs = require('node:fs');
console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
  localBin: process.env.PATH.split(require('node:path').delimiter)[0],
  input: process.argv.includes('stdin') ? fs.readFileSync(0, 'utf8') : '' }));
process.exitCode = Number(process.env.LAUNCHER_EXIT ?? 0);
`);
  return { root, script, cwd: join(root, 'caller') };
}

test('PowerShell front forwards arguments, caller cwd, local command PATH and native exit codes', { skip: !hasPowerShell }, async t => {
  const f = await fixture(t);
  const args = ['get', 'profile with spaces', '--config', '.\\a file.json', '--filter', 'title:"two words"', '--format=ansi'];
  const result = await run(f.script, args, { cwd: f.cwd, env: { ...process.env, LAUNCHER_EXIT: '7' } });
  assert.equal(result.code, 7, result.stderr);
  assert.equal(result.stderr, '');
  const body = JSON.parse(result.stdout);
  assert.deepEqual(body.args, args);
  assert.equal(body.cwd, f.cwd);
  assert.equal(body.localBin, join(f.root, 'node_modules', '.bin'));
});

test('PowerShell front keeps inherited stdin available and supports PowerShell pipeline input', { skip: !hasPowerShell }, async t => {
  const f = await fixture(t);
  const json = '{"items":[]}';
  const inherited = await run(f.script, ['stdin'], { cwd: f.cwd, input: json });
  assert.equal(inherited.code, 0, inherited.stderr);
  assert.equal(JSON.parse(inherited.stdout).input.trim(), json);
  const pipeline = join(f.root, 'pipeline.ps1');
  await writeFile(pipeline, `'${json}' | & '${f.script.replaceAll("'", "''")}' stdin\n`);
  const piped = await run(pipeline, [], { cwd: f.cwd });
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(JSON.parse(piped.stdout).input.trim(), json);
});

for (const fails of [false, true]) {
  test(`PowerShell front ${fails ? 'stops after failed installation' : 'installs missing dependencies once without polluting JSON stdout'}`,
    { skip: !hasPowerShell || process.platform !== 'win32' }, async t => {
      const f = await fixture(t);
      await writeFile(join(f.root, 'package.json'), JSON.stringify({ dependencies: { 'synthetic-launcher-dependency': '1.0.0' } }));
      const install = join(f.root, 'install.cjs');
      await writeFile(install, `
const fs = require('node:fs');
fs.appendFileSync('install.log', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
console.log('Synthetic installer output');
${fails ? 'process.exit(19);' : `
fs.mkdirSync('node_modules/synthetic-launcher-dependency', { recursive: true });
fs.writeFileSync('node_modules/synthetic-launcher-dependency/index.js', 'module.exports = {};');
`}
`);
      await writeFile(join(f.root, 'tools', 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${install}" %*\r\n`);
      const options = { cwd: f.cwd, env: { ...process.env, PATH: join(f.root, 'tools') + ';' + process.env.PATH } };
      const result = await run(f.script, ['--help'], options);
      assert.equal(result.code, fails ? 1 : 0, result.stderr);
      assert.match(result.stderr, /Synthetic installer output/);
      if (fails) {
        assert.equal(result.stdout, '');
        assert.match(result.stderr, /npm ci failed with exit code 19/);
      } else {
        assert.deepEqual(JSON.parse(result.stdout).args, ['--help']);
        assert.equal((await run(f.script, ['--version'], options)).code, 0);
      }
      const installs = (await readFile(join(f.root, 'install.log'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(installs.length, 1);
      assert.equal(installs[0].cwd, f.root);
      assert.deepEqual(installs[0].args, ['ci', '--no-audit', '--no-fund']);
    });
}

test('PowerShell checkout front invokes the actual JSON-first CLI', { skip: !hasPowerShell }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'devdash-pwsh-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = await run(launcher, ['--version', '--format', 'json'], { cwd: home, env: { ...process.env, DEVDASH_HOME: home } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).version, '0.1.0');
});

test('prompt hook runs once per Git project transition, composes with the prompt, and restores command status', { skip: !hasPowerShell }, async t => {
  const f = await fixture(t);
  const module = fileURLToPath(new URL('../scripts/DevDash.Prompt.psm1', import.meta.url));
  const script = join(f.root, 'prompt-test.ps1');
  await writeFile(script, `
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
function global:prompt {
    $global:PromptSawSuccess = $?
    $global:PromptSawExitCode = $global:LASTEXITCODE
    'SYNTHETIC> '
}
function global:Invoke-SyntheticDevDash {
    $record = @{ cwd = (Get-Location).Path; arguments = @($args) }
    [IO.File]::AppendAllText($env:PROMPT_LOG, ($record | ConvertTo-Json -Compress) + [Environment]::NewLine)
    $global:LASTEXITCODE = 99
}
Import-Module -Name '${module.replaceAll("'", "''")}'
$one = Join-Path $PSScriptRoot 'one'
$two = Join-Path $PSScriptRoot 'two'
$sub = Join-Path $one 'nested'
$null = New-Item -ItemType Directory -Path $sub,$two
& git init --quiet --template= $one
if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
& git init --quiet --template= $two
if ($LASTEXITCODE -ne 0) { throw 'git init failed' }
Enable-DevDashPrompt -Command Invoke-SyntheticDevDash -ArgumentList @('--cached-only','--format','ascii')
Enable-DevDashPrompt -Command Invoke-SyntheticDevDash
Set-Location $one
$global:LASTEXITCODE = 17
$first = prompt
if ($first -ne 'SYNTHETIC> ' -or $global:LASTEXITCODE -ne 17 -or $global:PromptSawExitCode -ne 17) {
    throw 'Original prompt or native exit status was not preserved'
}
$null = prompt
Set-Location $sub
$null = prompt
Set-Location $two
$null = prompt
Set-Location $PSScriptRoot
$null = prompt
Set-Location $one
$null = prompt
$global:LASTEXITCODE = 23
Write-Error 'Synthetic previous failure' -ErrorAction Ignore
$failure = prompt
if ($global:PromptSawSuccess -or $global:LASTEXITCODE -ne 23) { throw 'Previous command failure status was not preserved' }
Disable-DevDashPrompt
$null = prompt
Set-Location $two
$null = prompt
$records = @(Get-Content $env:PROMPT_LOG | ForEach-Object { $_ | ConvertFrom-Json })
if ($records.Count -ne 3) { throw "Expected 3 project transitions, got $($records.Count)" }
foreach ($record in $records) {
    if (($record.arguments -join '|') -ne 'repo|--cached-only|--format|ascii') { throw 'Arguments were not forwarded' }
}
if ((prompt) -ne 'SYNTHETIC> ') { throw 'Original prompt was not restored' }
Enable-DevDashPrompt -Command Invoke-SyntheticDevDash
function global:prompt { 'REPLACEMENT> ' }
Disable-DevDashPrompt
if ((prompt) -ne 'REPLACEMENT> ') { throw 'Disabling overwrote a newer prompt' }
Write-Output 'PROMPT_TEST_PASS'
`);
  const result = await run(script, [], { cwd: f.cwd, env: { ...process.env, PROMPT_LOG: join(f.root, 'calls.jsonl') } });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /PROMPT_TEST_PASS/);
  assert.equal(result.stderr, '');
});
