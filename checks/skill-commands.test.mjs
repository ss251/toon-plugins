import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { checkRepo, helpFromSpawn, lowestVersion, namedCommands } from './skill-commands.mjs';

/** A repository holding `files` (path → text), as a directory. */
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'skill-commands-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A SKILL.md whose frontmatter states `range` under `rangeKey`. */
const skill = (rangeKey, range, body = '# Sending') =>
  `---\nname: sending\n${rangeKey}: "${range}"\n---\n\n${body}\n`;
const sendingWithToonCli = (body) => skill('toon_cli', '>=0.3, <0.4', body);
const sendingWithToonClient = (body) => skill('toon-client', '>=5.0.0, <6', body);

/** A fake binary that has only `commands` (each `binary@version path`), recording each call. */
function binaries(...commands) {
  const calls = [];
  const runHelp = async (binary, version, path) => {
    const command = `${binary}@${version} ${path.join(' ')}`.trim();
    calls.push(command);
    return commands.includes(command)
      ? { exitCode: 0, stderr: '' }
      : { exitCode: 2, stderr: `error: unrecognized subcommand` };
  };
  return { runHelp, calls };
}

test('collects inline code spans and code-block lines that start with the binary', () => {
  const text = [
    'Run `toon event publish --kind 1` to post, or `toon --version` first.',
    'This is `toon` alone, and `toon-client send g.toon.relay` is another binary.',
    '',
    '```',
    '  toon channel open <peer> --deposit 10',
    'toonish line',
    '```',
  ].join('\n');

  assert.deepEqual(namedCommands(text, 'toon'), [['event', 'publish'], [], ['channel', 'open']]);
  assert.deepEqual(namedCommands(text, 'toon-client'), [['send']]);
});

test('reads the lowest version of a range from a skill\'s frontmatter', () => {
  assert.equal(lowestVersion(skill('toon_cli', '>=0.3, <0.4'), 'toon_cli'), '0.3.0');
  assert.equal(lowestVersion(skill('toon-client', '>=5.0.2, <6'), 'toon-client'), '5.0.2');
  assert.throws(() => lowestVersion(skill('toon_cli', '<0.4'), 'toon_cli'), /no lower bound/);
  assert.throws(() => lowestVersion(skill('toon_cli', '>=0.3'), 'toon-client'), /no `toon-client` key/);
});

test('a toon-cli skill naming a command the lowest toon_cli lacks fails', async () => {
  const root = repo({
    'plugins/toon-cli/skills/sending-with-toon-cli/SKILL.md': sendingWithToonCli(
      'Run `toon --version`, then `toon event publish --kind 1`.',
    ),
    'plugins/toon-cli/skills/operating-an-agent-node/references/peering.md':
      '```\ntoon frobnicate <peer>\n```',
  });
  const { runHelp, calls } = binaries('toon@0.3.0', 'toon@0.3.0 event publish');

  const problems = await checkRepo(root, runHelp);

  assert.deepEqual(calls.sort(), ['toon@0.3.0', 'toon@0.3.0 event publish', 'toon@0.3.0 frobnicate']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /operating-an-agent-node\/references\/peering\.md/);
  assert.match(problems[0], /`toon frobnicate` is not a command of toon 0\.3\.0/);
  assert.match(problems[0], /unrecognized subcommand/);
});

test('a toon-nostr skill naming any client command fails, whether or not the command exists', async () => {
  const root = repo({
    'plugins/toon-cli/skills/sending-with-toon-cli/SKILL.md': sendingWithToonCli('`toon --version`'),
    'plugins/toon-nostr/skills/social/SKILL.md': 'Post with `toon event publish`.',
    'plugins/toon-nostr/skills/social/references/nip-25.md': '```\ntoon-client send g.toon.relay\n```',
  });
  const { runHelp } = binaries('toon@0.3.0', 'toon@0.3.0 event publish', 'toon-client@5.0.0 send');

  const problems = await checkRepo(root, runHelp);

  assert.deepEqual(problems, [
    'plugins/toon-nostr/skills/social/SKILL.md: names `toon event publish`, but only toon-cli skills may name `toon` commands',
    'plugins/toon-nostr/skills/social/references/nip-25.md: names `toon-client send`, but only toon-client skills may name `toon-client` commands',
  ]);
});

test('a toon-client skill naming an unknown toon-client command, or a bare toon one, fails', async () => {
  const root = repo({
    'plugins/toon-client/skills/sending-with-toon-client/SKILL.md': sendingWithToonClient(
      'Run `toon-client --version`, then `toon-client frobnicate`, not `toon send` or `toon`.',
    ),
  });
  const { runHelp, calls } = binaries('toon-client@5.0.0');

  const problems = await checkRepo(root, runHelp);

  assert.deepEqual(calls.sort(), ['toon-client@5.0.0', 'toon-client@5.0.0 frobnicate']);
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /`toon-client frobnicate` is not a command of toon-client 5\.0\.0/);
  assert.match(problems.join('\n'), /names `toon send`, but only toon-cli skills may name `toon` commands/);
});

test('a Linux toon binary this host cannot execute is a skip, not a throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-commands-elf-'));
  const command = join(root, 'toon');
  // ELF magic is enough: Darwin refuses it with ENOEXEC and does not run it.
  writeFileSync(command, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
  chmodSync(command, 0o755);
  const run = spawnSync(command, ['--help'], { encoding: 'utf8' });

  const toon = helpFromSpawn('toon', '0.6.0', command, run);
  if (platform() !== 'linux' && run.error?.code === 'ENOEXEC') {
    assert.equal(toon.exitCode, 0);
    assert.match(toon.skip, /skip: not executing toon@0\.6\.0/);
    assert.match(toon.skip, /were not checked here/);
    assert.match(toon.skip, /Ubuntu CI still runs them/);
  } else {
    assert.equal(toon.skip, null);
    assert.notEqual(toon.exitCode, 0);
  }

  // Another binary's ENOEXEC is a failed run. Skipping it would hide a broken install.
  const other = helpFromSpawn('toon-client', '5.0.0', command, run);
  assert.equal(other.skip, null);
  if (run.error) {
    assert.notEqual(other.exitCode, 0);
    assert.match(other.stderr, /could not execute/);
  }
});

test('a binary this host can run keeps the exit code of --help', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-commands-sh-'));
  const command = join(root, 'toon-client');
  writeFileSync(command, '#!/bin/sh\necho "error: unrecognized subcommand" >&2\nexit 2\n');
  chmodSync(command, 0o755);
  const run = spawnSync(command, ['frobnicate', '--help'], { encoding: 'utf8' });
  const outcome = helpFromSpawn('toon-client', '5.0.0', command, run);
  assert.equal(outcome.skip, null);
  assert.equal(outcome.exitCode, 2);
  assert.match(outcome.stderr, /unrecognized subcommand/);
});
