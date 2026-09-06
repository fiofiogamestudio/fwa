#!/usr/bin/env node

import { runCli } from '../src/cli.js';

const controller = new AbortController();
let receivedSignal = null;
let forcedExitTimer = null;

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 143;
}

function handleSignal(signal) {
  if (receivedSignal !== null) {
    process.exit(signalExitCode(signal));
  }
  receivedSignal = signal;
  const reason = new Error(`FWA received ${signal}.`);
  reason.code = 'FWA_CLI_ABORTED';
  controller.abort(reason);
  forcedExitTimer = setTimeout(() => {
    process.exit(signalExitCode(signal));
  }, 15_000);
  forcedExitTimer.unref?.();
}

const onInterrupt = () => handleSignal('SIGINT');
const onTerminate = () => handleSignal('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);

let exitCode;
try {
  exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    signal: controller.signal
  });
} finally {
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  if (forcedExitTimer !== null) clearTimeout(forcedExitTimer);
}

process.exitCode = receivedSignal === null ? exitCode : signalExitCode(receivedSignal);
