// Graceful shutdown: what a termination signal does depends on whether a run is
// in flight. Driven through real child processes — signal handling is exactly the
// part that can't be faked in-process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const RUN_CONTROL = new URL('../src/run-control.js', import.meta.url).href;

// Start a child running `script`, wait for it to print READY, send `signal`, and
// resolve with its exit code/signal plus everything it printed.
function signalChild(script, signal = 'SIGTERM') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let signalled = false;
    const guard = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`child hung: ${out}`)); }, 10000);

    child.stdout.on('data', (d) => {
      out += d;
      if (!signalled && out.includes('READY')) { signalled = true; child.kill(signal); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => { clearTimeout(guard); reject(err); });
    child.on('close', (code, sig) => { clearTimeout(guard); resolve({ code, sig, out }); });
  });
}

test('SIGTERM during a run aborts cooperatively instead of killing the process', async () => {
  // Stands in for the pipeline: notices the abort, then needs a moment to save.
  // A hard kill would cut it off before SAVED is ever printed.
  const { code, sig, out } = await signalChild(`
    import { installAbortSignals, beginRun, endRun, isAborted, exitRequested } from ${JSON.stringify(RUN_CONTROL)};
    installAbortSignals();
    beginRun();
    console.log('READY');
    const iv = setInterval(() => {
      if (!isAborted()) return;
      clearInterval(iv);
      setTimeout(() => {           // the save the signal must not interrupt
        console.log('SAVED');
        console.log('EXIT_REQUESTED=' + exitRequested());
        endRun();
        process.exit(0);
      }, 200);
    }, 20);
  `);

  assert.equal(sig, null, 'the process must not be torn down by the signal');
  assert.equal(code, 0, 'it exits on its own terms once the save is done');
  assert.match(out, /SAVED/, 'the save ran to completion after the signal');
  assert.match(out, /EXIT_REQUESTED=true/, 'the caller is told to shut down afterwards');
});

test('SIGTERM outside a run ends the process immediately', async () => {
  // The idle scheduler between cron ticks: nothing to save, so `docker stop`
  // and Ctrl+C must still quit at once rather than hang.
  const { code, out } = await signalChild(`
    import { installAbortSignals } from ${JSON.stringify(RUN_CONTROL)};
    installAbortSignals();
    console.log('READY');
    setInterval(() => {}, 1000);
  `);

  assert.equal(code, 143, 'exits 143 (128 + SIGTERM), as Node would have');
  assert.doesNotMatch(out, /abgebrochen/, 'no wind-down when there is nothing to wind down');
});

test('a second SIGTERM during the wind-down gives up waiting', async () => {
  // First signal starts the graceful abort; the "pipeline" here never finishes,
  // so the operator's second signal has to end it.
  const { code, out } = await signalChild(`
    import { installAbortSignals, beginRun } from ${JSON.stringify(RUN_CONTROL)};
    installAbortSignals();
    beginRun();
    console.log('READY');
    setInterval(() => {}, 1000);   // never notices the abort
    // Second signal, once the first has been handled.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
  `);

  assert.equal(code, 130, 'the repeat signal exits immediately');
  assert.match(out, /erneut/, 'and says so');
});
