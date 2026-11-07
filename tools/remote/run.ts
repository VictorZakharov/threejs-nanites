// Runs the harness on a remote test PC over SSH (`npm run remote -- <harness options>`), so a weak GPU is measured without
// anyone walking to it: the reference low-end AMD PC (AGENTS.md's Goal), set up once with tools/remote/setup-device.ps1.
// It checks out this checkout's commit there (it must be pushed), runs `npm run harness` with the options, prints its
// output, and copies the remote tools/out back into tools/out/remote/. Its shell is Windows' cmd: each option goes in
// double quotes, so a `&` in --query stays in it.
//   --host=amd-pc       the SSH host (an alias in ~/.ssh/config; default amd-pc)
//   --dir=...           the repo there (default C:/Users/<its user>/threejs-nanites)
//   --no-sync           run what's checked out there
//   --headed            a visible browser on that PC's desktop (HARNESS_HEADED=1): its frames are presented and
//                       composited, so frame pacing, the GPU queue and the panel's fps are what a person sees. An SSH
//                       session has no desktop: it runs as a scheduled task in the signed-in user's session (someone must
//                       be signed in; a window opens on that screen while it runs).
// Without --url it serves the remote checkout itself (npm run harness starts its own server), so test the preview with
// --url=https://victorzakharov.github.io/threejs-nanites/pr-preview/pr-N/ or the commit's own build with --dist.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const take = (name: string): string | undefined => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const [a] = args.splice(i, 1);
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : '';
};
const host = take('host') || 'amd-pc';
const sync = take('no-sync') === undefined;
const headed = take('headed') !== undefined;
const ssh = (command: string, inherit = false) =>
  spawnSync('ssh', ['-o', 'LogLevel=ERROR', host, command], { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe' });
const user = ssh('echo %USERNAME%').stdout?.trim();
if (!user) {
  console.error(`[remote ${host}] can't reach it over SSH (is it on and awake?)`);
  process.exit(1);
}
const dir = (take('dir') || `C:/Users/${user}/threejs-nanites`).replace(/\\/g, '/');
const winDir = dir.replace(/\//g, '\\');

const git = (...a: string[]): string => spawnSync('git', a, { encoding: 'utf8' }).stdout.trim();
const commit = git('rev-parse', 'HEAD');
const steps = [`cd /d "${winDir}"`];
if (sync) {
  // (pushed? the remote fetches it from GitHub)
  if (!git('branch', '-r', '--contains', commit)) {
    console.error(`commit ${commit.slice(0, 7)} isn't pushed: push it first (or --no-sync)`);
    process.exit(1);
  }
  steps.push('git fetch -q origin', `git checkout -q --detach ${commit}`, 'npm install --no-audit --no-fund --silent');
}
const quoted = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ');
const harness = `npm run harness -- ${quoted}`;
console.log(`[remote ${host}${headed ? ', headed' : ''}] ${sync ? `at ${commit.slice(0, 7)}: ` : ''}${harness}`);

let code: number;
if (!headed) {
  steps.push(harness);
  code = ssh(steps.join(' && '), true).status ?? 1;
} else {
  // (a .cmd file run by a scheduled task in the user's desktop session; it writes a log and, last, a done marker)
  const log = `${winDir}\\tools\\tmp\\remote-run.log`, done = `${winDir}\\tools\\tmp\\remote-run.done`;
  // (in a batch file, npm (npm.cmd) without call never returns: the done marker was never written)
  const batch = steps.map((x) => (x.startsWith('npm ') ? `call ${x}` : x));
  batch.push('set HARNESS_HEADED=1', `call ${harness}`);
  const script = ['@echo off', `if not exist "${winDir}\\tools\\tmp" mkdir "${winDir}\\tools\\tmp"`, `del /q "${done}" 2>nul`,
    `(${batch.join(' && ')}) > "${log}" 2>&1`, `echo %errorlevel% > "${done}"`].join('\r\n');
  mkdirSync('tools/tmp', { recursive: true });
  writeFileSync('tools/tmp/remote-run.cmd', script);
  ssh(`if not exist "${winDir}\\tools\\tmp" mkdir "${winDir}\\tools\\tmp"`);
  spawnSync('scp', ['-q', '-o', 'LogLevel=ERROR', 'tools/tmp/remote-run.cmd', `${host}:${dir}/tools/tmp/remote-run.cmd`], { stdio: 'inherit' });
  ssh(`del /q "${done}" 2>nul`);
  // (/IT: only while the user is signed in, in their session: the desktop the window opens on)
  const made = ssh(`schtasks /Create /F /TN nanite-harness /SC ONCE /ST 23:59 /IT /RL HIGHEST /TR "${winDir}\\tools\\tmp\\remote-run.cmd" && schtasks /Run /TN nanite-harness`);
  if (made.status !== 0) {
    console.error(`[remote ${host}] couldn't start the task: ${made.stdout}${made.stderr}`);
    process.exit(1);
  }
  const limit = Date.now() + (Number(args.find((a) => a.startsWith('--timeout='))?.slice(10) ?? 600) + 300) * 1000;
  let shown = 0;
  for (;;) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
    const out = ssh(`type "${log}" 2>nul`).stdout ?? '';
    if (out.length > shown) {
      process.stdout.write(out.slice(shown));
      shown = out.length;
    }
    const fin = ssh(`type "${done}" 2>nul`).stdout?.trim();
    if (fin) {
      code = Number(fin) || 0;
      break;
    }
    if (Date.now() > limit) {
      console.error(`[remote ${host}] no result in time: the task is left running (schtasks /End /TN nanite-harness)`);
      code = 1;
      break;
    }
  }
  ssh('schtasks /Delete /F /TN nanite-harness');
}

mkdirSync('tools/out/remote', { recursive: true });
// (the screenshots and reports, back here)
const copy = spawnSync('scp', ['-q', '-o', 'LogLevel=ERROR', '-r', `${host}:${dir}/tools/out/*`, 'tools/out/remote/'], { stdio: 'inherit' });
console.log(copy.status === 0 ? `[remote ${host}] tools/out copied to tools/out/remote/` : `[remote ${host}] copying tools/out failed`);
process.exit(code);
