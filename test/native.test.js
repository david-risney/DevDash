import test from 'node:test';
import assert from 'node:assert/strict';
import { endianness } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { frameMessage, nativeManifest, serveNative } from '../src/native.js';

function decode(buffer) {
  const values = [];
  while (buffer.length) {
    const size = endianness() === 'LE' ? buffer.readUInt32LE() : buffer.readUInt32BE();
    values.push(JSON.parse(buffer.subarray(4, size + 4).toString('utf8')));
    buffer = buffer.subarray(size + 4);
  }
  return values;
}

async function exchange(chunks, dependencies) {
  const output = [];
  const stream = new Writable({ write(chunk, encoding, callback) { output.push(chunk); callback(); } });
  await serveNative(Readable.from(chunks), stream, dependencies);
  return decode(Buffer.concat(output));
}

test('native messaging supports split frames, multiple requests, and UTF-8 payloads', async () => {
  const data = Buffer.concat([frameMessage({ command: 'profiles' }), frameMessage({ command: 'get', profile: 'bugs' })]);
  const calls = [];
  const output = await exchange([data.subarray(0, 2), data.subarray(2, 7), data.subarray(7)], {
    executeCommand: async (args) => { calls.push(args); return { output: { title: '\u00e9' } }; },
  });
  assert.deepEqual(calls, [['profile', 'list'], ['get', 'bugs']]);
  assert.deepEqual(output, [{ title: '\u00e9' }, { title: '\u00e9' }]);
});

test('native command allowlist cannot execute arbitrary commands or override storage', async () => {
  for (const request of [
    { command: 'profile set' },
    { command: 'native', action: 'install' },
    { command: 'native extensions add', extensionId: 'a'.repeat(32) },
    { command: 'native-install' },
    { command: 'native-status' },
    { command: 'get', profile: '--home', home: 'other' },
    { command: 'get', profile: '--all' },
    { command: 'get', all: 'true' },
    { command: 'get', profile: [] },
    { command: 'get', profile: 'edge', query: [] },
    { command: 'get', profile: 'edge', query: '--all' },
    { command: 'get', all: true, query: 'bugs' },
    { command: 'get', query: 'bugs' },
    { command: 'profiles', all: true },
    { command: 'get', profile: 'bugs', cacheMode: 'unknown' },
    { command: 'get', profile: 'bugs', cacheMode: 'adaptive', cachedOnly: true },
    { command: 'get', profile: 'bugs', cacheMode: 'adaptive', fastQueryMs: '500' },
    { command: 'get', profile: 'bugs', cacheMode: 'adaptive', fastQueryMs: 0 },
    { command: 'get', profile: 'bugs', cacheMode: 'adaptive', fastQueryMs: 60001 },
    { command: 'get', profile: 'bugs', fastQueryMs: 500 },
    { command: 'refresh', profile: 'bugs', cacheMode: 'adaptive' },
    { command: 'profile-set', profile: 'bugs', file: 'arbitrary-path' },
    { command: 'profile-set', profile: 'bugs', definition: null },
    { command: 'profile-remove' },
    { command: 'avatar', profile: 'bugs', itemId: '1', repository: [] },
    { command: 'avatar', profile: 'bugs', itemId: '1', repository: '--home' },
    { command: ['get'], profile: 'bugs' },
    null,
    [],
  ]) {
    const output = await exchange([frameMessage(request)], {
      executeCommand: async () => { assert.fail('Invalid request dispatched'); },
    });

    assert.equal(output[0].error.code, 'INVALID_REQUEST');
  }
});

test('native profile definitions use validated stdin, never arbitrary files', async () => {
  const calls = [];
  const definition = { provider: 'github', resource: 'prs', repository: 'owner/repo', refreshSeconds: 60 };
  await exchange([
    frameMessage({ command: 'profile-set', profile: 'prs', definition }),
    frameMessage({ command: 'profile-remove', profile: 'prs' }),
  ], {
    executeCommand: async (args, dependencies) => {
      let value;
      if (dependencies.stdin) {
        let text = '';
        for await (const chunk of dependencies.stdin) text += chunk;
        value = JSON.parse(text);
      }
      calls.push({ args, value });
      return { output: {} };
    },
  });
  assert.deepEqual(calls, [
    { args: ['profile', 'set', 'prs', '--file', '-'], value: definition },
    { args: ['profile', 'remove', 'prs'], value: undefined },
  ]);
});

test('valid native query flags are forwarded as fixed argument strings', async () => {
  const calls = [];
  await exchange([
    frameMessage({ command: 'refresh', all: true, due: true }),
    frameMessage({ command: 'get', profile: 'bugs', cachedOnly: true }),
    frameMessage({ command: 'status', all: true }),
    frameMessage({ command: 'get', profile: 'edge', query: 'my-prs', cachedOnly: true }),
    frameMessage({ command: 'get', profile: 'edge', query: 'my-prs', cacheMode: 'adaptive', fastQueryMs: 750 }),
  ], {
    executeCommand: async (args) => { calls.push(args); return { output: {} }; },
  });
  assert.deepEqual(calls, [
    ['refresh', '--all', '--due'],
    ['get', 'bugs', '--cached-only'],
    ['cache', 'status', '--all'],
    ['get', 'edge', '--cached-only', '--query', 'my-prs'],
    ['get', 'edge', '--query', 'my-prs', '--cache-mode', 'adaptive', '--fast-query-ms', '750'],
  ]);
});

test('native malformed JSON reports an error and keeps processing the connection', async () => {
  const invalid = Buffer.from('x');
  const header = Buffer.alloc(4);
  if (endianness() === 'LE') header.writeUInt32LE(1);
  else header.writeUInt32BE(1);
  const output = await exchange([Buffer.concat([header, invalid]), frameMessage({ command: 'profiles' })], {
    executeCommand: async () => ({ output: { profiles: [] } }),
  });
  assert.equal(output[0].error.code, 'INVALID_JSON');
  assert.deepEqual(output[1], { profiles: [] });
});

test('partial frames and oversized input terminate explicitly', async () => {
  const partial = frameMessage({ command: 'profiles' }).subarray(0, 7);
  await assert.rejects(exchange([partial]), { code: 'INVALID_FRAME' });
  const header = Buffer.alloc(4);
  if (endianness() === 'LE') header.writeUInt32LE(1024 * 1024 + 1);
  else header.writeUInt32BE(1024 * 1024 + 1);
  await assert.rejects(exchange([header]), { code: 'MESSAGE_TOO_LARGE' });
});

test('oversized native output is a bounded error frame', () => {
  const output = decode(frameMessage({ text: 'x'.repeat(1024 * 1024) }));
  assert.equal(output[0].error.code, 'MESSAGE_TOO_LARGE');
});

test('native manifest is restricted to a real extension ID and absolute launcher', () => {
  const launcher = process.platform === 'win32' ? 'C:\\tools\\native.cmd' : '/tools/native';
  const manifest = nativeManifest('a'.repeat(32), launcher);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${'a'.repeat(32)}/`]);
  assert.equal(manifest.type, 'stdio');
  assert.throws(() => nativeManifest('*', launcher), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => nativeManifest('a'.repeat(32), 'relative'), { code: 'INVALID_ARGUMENT' });
});
