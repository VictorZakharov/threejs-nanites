// Runs the harness on a remote test PC over SSH (`npm run remote -- <harness options>`), so a weak GPU is measured without
// anyone walking to it: the reference low-end AMD PC (AGENTS.md's Goal), set up once with tools/remote/setup-device.ps1.
// It checks out this checkout's commit there (it must be pushed), runs `npm run harness` with the options, prints its
// output as it comes, and copies the remote tools/out back into tools/out/remote/. Its shell is Windows' cmd: each option
// goes in double quotes, so a `&` in --query stays in it.
//   --host=amd-pc       the SSH host (an alias in ~/.ssh/config; default amd-pc)
//   --dir=...           the repo there (default %USERPROFILE%\threejs-nanites)
//   --no-sync           run what's checked out there
// Without --url it serves the remote checkout itself (npm run harness starts its own server), so test the preview with
// --url=https://victorzakharov.github.io/threejs-nanites/pr-preview/pr-N/ or the commit's own build with --dist.
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const take = (name: string): string | undefined => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const [a] = args.splice(i, 1);
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : '';
};
const host = take('host') || 'amd-pc';
const dir = take('dir') || '%USERPROFILE%\\threejs-nanites';
const sync = take('no-sync') === undefined;

const git = (...a: string[]): string => spawnSync('git', a, { encoding: 'utf8' }).stdout.trim();
const commit = git('rev-parse', 'HEAD');
const steps = [`cd /d "${dir}"`];
if (sync) {
  // (pushed? the remote fetches it from GitHub)
  if (!git('branch', '-r', '--contains', commit)) {
    console.error(`commit ${commit.slice(0, 7)} isn't pushed: push it first (or --no-sync)`);
    process.exit(1);
  }
  steps.push('git fetch -q origin', `git checkout -q --detach ${commit}`, 'npm install --no-audit --no-fund --silent');
}
const quoted = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ');
steps.push(`npm run harness -- ${quoted}`);
console.log(`[remote ${host}] ${sync ? `at ${commit.slice(0, 7)}: ` : ''}npm run harness -- ${quoted}`);

const run = spawn('ssh', ['-o', 'LogLevel=ERROR', host, steps.join(' && ')], { stdio: 'inherit' });
run.on('exit', (code) => {
  mkdirSync('tools/out/remote', { recursive: true });
  // (the screenshots and reports, back here; scp reads the remote path with forward slashes)
  const where = dir.replace('%USERPROFILE%', `C:/Users/${spawnSync('ssh', ['-o', 'LogLevel=ERROR', host, 'echo %USERNAME%'], { encoding: 'utf8' }).stdout.trim()}`).replace(/\\/g, '/');
  const copy = spawnSync('scp', ['-q', '-o', 'LogLevel=ERROR', '-r', `${host}:${where}/tools/out/*`, 'tools/out/remote/'], { stdio: 'inherit' });
  console.log(copy.status === 0 ? `[remote ${host}] tools/out copied to tools/out/remote/` : `[remote ${host}] copying tools/out failed`);
  process.exit(code ?? 1);
});
