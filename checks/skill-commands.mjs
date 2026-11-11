// Fails when a skill names a command its client's lowest supported version does not have.
//
// The rule for what counts as a named command is toon_cli's `named_commands`
// (tests/skill.rs), so both repositories agree on what a skill names.
//
// Run from the repository root: `node checks/skill-commands.mjs`. It fetches each client
// at the low end of the range its sending skill's frontmatter states (toon from the
// toon_cli release, toon-client from npm) and runs `--help` on every command the skills
// name. It needs network access, curl, tar and npm. The published `toon` binary is a Linux
// executable. On another OS the check still verifies that archive, skips only executing it,
// prints why, and still checks `toon-client`. The skip is not a pass of the `toon` commands.
// Ubuntu CI still runs them.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The plugins that are a client's: the binary its skills may name, and the sending skill
 * whose frontmatter key holds the supported range. Any other plugin may name no binary.
 */
export const CLIENTS = {
  'toon-cli': { binary: 'toon', sendingSkill: 'sending-with-toon-cli', rangeKey: 'toon_cli' },
  'toon-client': { binary: 'toon-client', sendingSkill: 'sending-with-toon-client', rangeKey: 'toon-client' },
};

/**
 * Every command a skill file names, as its command path: an inline code span that
 * starts with `<binary> `, and a line of a code block that does. The path is the
 * leading plain words; a value (`<placeholder>`, `g.toon.relay`) or a flag ends it.
 *
 * @param {string} text
 * @param {string} binary
 * @returns {string[][]}
 */
export function namedCommands(text, binary) {
  const prefix = `${binary} `;
  const spans = text
    .split('`')
    .filter((_, i) => i % 2 === 1)
    .filter((span) => span.startsWith(prefix));
  const lines = text
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith(prefix));
  return [...spans, ...lines].map((named) => commandPath(named.slice(prefix.length)));
}

/** @param {string} rest */
function commandPath(rest) {
  const path = [];
  for (const word of rest.split(/\s+/).filter(Boolean)) {
    if (!/^[a-z-]+$/.test(word) || word.startsWith('-')) break;
    path.push(word);
  }
  return path;
}

/**
 * The lowest version a skill supports: the `>=` bound of the range under `rangeKey` in
 * its frontmatter, as `major.minor.patch`.
 *
 * @param {string} skill the text of a SKILL.md
 * @param {string} rangeKey
 * @returns {string}
 */
export function lowestVersion(skill, rangeKey) {
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const line = frontmatter.split('\n').find((l) => l.startsWith(`${rangeKey}:`));
  if (line === undefined) throw new Error(`The skill's frontmatter has no \`${rangeKey}\` key.`);
  const range = line.slice(rangeKey.length + 1).trim().replace(/^["']|["']$/g, '');
  const bound = range.match(/>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (bound === null) throw new Error(`The range \`${range}\` under \`${rangeKey}\` has no lower bound.`);
  return [bound[1], bound[2] ?? '0', bound[3] ?? '0'].join('.');
}

/**
 * @typedef {(binary: string, version: string, path: string[]) =>
 *   Promise<{ exitCode: number, stderr: string }>} RunHelp
 *   Runs `<binary> <path...> --help` at that version.
 */

/**
 * Every problem with the commands the skills under `root/plugins` name, one line each.
 * No problems means the check passes.
 *
 * @param {string} root
 * @param {RunHelp} runHelp
 * @returns {Promise<string[]>}
 */
export async function checkRepo(root, runHelp) {
  const problems = [];
  for (const plugin of readdirSync(join(root, 'plugins')).sort()) {
    const files = skillFiles(root, plugin).map((path) => ({
      path,
      text: readFileSync(join(root, path), 'utf8'),
    }));
    for (const [owner, client] of Object.entries(CLIENTS)) {
      const named = files.flatMap(({ path, text }) =>
        namedCommands(text, client.binary).map((command) => ({ path, command })),
      );
      if (owner === plugin) {
        if (named.length === 0) continue;
        const sendingSkill = join(root, 'plugins', plugin, 'skills', client.sendingSkill, 'SKILL.md');
        const version = lowestVersion(readFileSync(sendingSkill, 'utf8'), client.rangeKey);
        problems.push(...(await checkCommands(client.binary, version, named, runHelp)));
      } else {
        for (const { path, command } of named) {
          problems.push(
            `${path}: names \`${[client.binary, ...command].join(' ')}\`, but only ${owner} skills` +
              ` may name \`${client.binary}\` commands`,
          );
        }
      }
    }
  }
  return problems;
}

/**
 * The named commands that `binary` at `version` lacks.
 *
 * @param {string} binary
 * @param {string} version
 * @param {{ path: string, command: string[] }[]} named
 * @param {RunHelp} runHelp
 */
async function checkCommands(binary, version, named, runHelp) {
  const help = new Map();
  const problems = [];
  for (const { path, command } of named) {
    const commandLine = [binary, ...command].join(' ');
    if (!help.has(commandLine)) help.set(commandLine, await runHelp(binary, version, command));
    const { exitCode, stderr } = help.get(commandLine);
    if (exitCode !== 0) {
      problems.push(
        `${path}: \`${commandLine}\` is not a command of ${binary} ${version}` +
          ` (\`${commandLine} --help\` exited ${exitCode}): ${stderr.trim().split('\n')[0]}`,
      );
    }
  }
  return problems;
}

/**
 * Every Markdown file of every skill in a plugin, relative to the repository root: each
 * `SKILL.md` and the references beside it.
 *
 * @param {string} root
 * @param {string} plugin
 * @returns {string[]}
 */
function skillFiles(root, plugin) {
  const skills = join('plugins', plugin, 'skills');
  if (!existsSync(join(root, skills))) return [];
  return readdirSync(join(root, skills), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = join(skills, entry.name);
      const references = existsSync(join(root, dir, 'references'))
        ? readdirSync(join(root, dir, 'references')).map((name) => join(dir, 'references', name))
        : [];
      return [join(dir, 'SKILL.md'), ...references].filter((path) => existsSync(join(root, path)));
    })
    .sort();
}

/**
 * The outcome of one `<binary> <path...> --help`. A published Linux `toon` release that
 * this host cannot execute is a skip: the commands were not checked, and that is not
 * evidence they are missing. A skip is not a pass. Any other spawn error is a failed run,
 * which the caller reports as a problem line instead of an uncaught throw.
 *
 * @param {string} binary
 * @param {string} version
 * @param {string} command absolute path of the installed binary
 * @param {import('node:child_process').SpawnSyncReturns<string>} run
 * @returns {{ exitCode: number, stderr: string, skip: string | null }}
 */
export function helpFromSpawn(binary, version, command, run) {
  if (!run.error) return { exitCode: run.status ?? 1, stderr: run.stderr ?? '', skip: null };
  const code = typeof run.error.code === 'string' ? run.error.code : 'UNKNOWN';
  if (binary === 'toon' && code === 'ENOEXEC' && platform() !== 'linux') {
    return {
      exitCode: 0,
      stderr: '',
      skip:
        `skip: not executing ${binary}@${version}. The published ${binary} release is a Linux ` +
        `executable and this host is ${platform()} ${arch()} (${code}), so the ${binary} commands ` +
        `the skills name were not checked here. Ubuntu CI still runs them.`,
    };
  }
  return {
    exitCode: 127,
    stderr: `could not execute \`${command}\`: ${code}: ${run.error.message}`,
    skip: null,
  };
}

/** Installs each client version once, into a temporary directory, and runs it there. */
function realBinaries() {
  /** @type {Map<string, string>} */
  const installed = new Map();
  /** @type {Set<string>} binaries whose `--help` this host cannot execute */
  const skipped = new Set();
  /** @type {(binary: string, version: string) => string} */
  const install = (binary, version) => {
    const dir = mkdtempSync(join(tmpdir(), `${binary}-${version}-`));
    if (binary === 'toon') {
      const target = `toon-v${version}-linux-${arch() === 'arm64' ? 'aarch64' : 'x86_64'}`;
      const url = `https://github.com/toon-protocol/toon_cli/releases/download/v${version}/${target}.tar.gz`;
      const tarball = join(dir, `${target}.tar.gz`);
      execFileSync('curl', ['-fsSL', '-o', tarball, url]);
      const expected = execFileSync('curl', ['-fsSL', `${url}.sha256`], { encoding: 'utf8' }).split(/\s/)[0];
      const actual = createHash('sha256').update(readFileSync(tarball)).digest('hex');
      if (actual !== expected) throw new Error(`${url} has SHA-256 ${actual}, not ${expected}.`);
      execFileSync('tar', ['xzf', tarball, '-C', dir]);
      return join(dir, target, 'toon');
    }
    if (binary === 'toon-client') {
      // --ignore-scripts: the gate runs `--help`, so no package needs to run code at install time.
      execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', dir, `@toon-protocol/client@${version}`], {
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      return join(dir, 'node_modules', '.bin', 'toon-client');
    }
    throw new Error(`No way to install ${binary}.`);
  };
  /** @type {RunHelp} */
  const runHelp = async (binary, version, path) => {
    const key = `${binary}@${version}`;
    if (skipped.has(key)) return { exitCode: 0, stderr: '' };
    let command = installed.get(key);
    if (command === undefined) {
      console.error(`Installing ${key}...`);
      command = install(binary, version);
      installed.set(key, command);
    }
    const run = spawnSync(command, [...path, '--help'], { encoding: 'utf8' });
    const outcome = helpFromSpawn(binary, version, command, run);
    if (outcome.skip !== null) {
      skipped.add(key);
      console.error(outcome.skip);
      return { exitCode: 0, stderr: '' };
    }
    return { exitCode: outcome.exitCode, stderr: outcome.stderr };
  };
  return { runHelp, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const binaries = realBinaries();
  const problems = await checkRepo(process.cwd(), binaries.runHelp);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`\n${problems.length} command(s) in the skills fail the check.`);
    process.exit(1);
  }
  console.error(
    binaries.skipped.size > 0
      ? 'Every command this host could run exists in its client\'s lowest supported version.'
      : 'Every command the skills name exists in its client\'s lowest supported version.',
  );
}
