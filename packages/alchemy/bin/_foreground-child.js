// Vendored from foreground-child@4.0.3 (ISC, © Isaac Z. Schlueter et al.)
// https://github.com/tapjs/foreground-child
//
// Inlined so we can pipe the child's stderr through a filter — upstream
// hardcodes `stdio = [0, 1, 2]`, which makes interception impossible without
// forking. The only behavioral change here is the optional `stderrFilter`
// option: when provided, stderr is piped instead of inherited and each line
// is passed through the filter (return false to drop, true to forward).
// Everything else — signal proxying, the watchdog, IPC bridging — is
// preserved verbatim from upstream.
import { spawn } from "node:child_process";
import constants from "node:constants";
import { onExit } from "signal-exit";

const allSignals = Object.keys(constants).filter(
  (k) => k.startsWith("SIG") && k !== "SIGPROF" && k !== "SIGKILL",
);

const proxySignals = (child) => {
  const listeners = new Map();
  for (const sig of allSignals) {
    const listener = () => {
      try {
        child.kill(sig);
      } catch (_) {}
    };
    try {
      process.on(sig, listener);
      listeners.set(sig, listener);
    } catch (_) {}
  }
  const unproxy = () => {
    for (const [sig, listener] of listeners) {
      process.removeListener(sig, listener);
    }
  };
  child.on("exit", unproxy);
  return unproxy;
};

const watchdogCode = String.raw`
const pid = parseInt(process.argv[1], 10)
process.title = 'node (foreground-child watchdog pid=' + pid + ')'
if (!isNaN(pid)) {
  let barked = false
  const interval = setInterval(() => {}, 60000)
  const bark = () => {
    clearInterval(interval)
    if (barked) return
    barked = true
    process.removeListener('SIGHUP', bark)
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL')
        setTimeout(() => process.exit(), 200)
      } catch (_) {}
    }, 500)
  }
  process.on('SIGHUP', bark)
}
`;

const watchdog = (child) => {
  let dogExited = false;
  const dog = spawn(
    process.execPath,
    ["-e", watchdogCode, String(child.pid)],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  dog.on("exit", () => (dogExited = true));
  dog.stderr.pipe(process.stderr, { end: false });
  child.on("exit", () => {
    if (!dogExited) dog.kill("SIGKILL");
  });
  process.on("exit", () => {
    if (!dogExited) dog.kill("SIGKILL");
  });
  return dog;
};

const isPromise = (o) =>
  !!o && typeof o === "object" && typeof o.then === "function";

/**
 * @param {string} program
 * @param {string[]} args
 * @param {{ stderrFilter?: (line: string) => boolean, cleanup?: Function }} [opts]
 */
export function foregroundChild(program, args, opts = {}) {
  const { stderrFilter, cleanup = () => {} } = opts;

  const stdio = stderrFilter ? [0, 1, "pipe"] : [0, 1, 2];
  if (process.send) stdio.push("ipc");

  const child = spawn(program, args, { stdio });

  if (stderrFilter && child.stderr) {
    let buf = "";
    child.stderr.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.search(/\r?\n/)) !== -1) {
        const eol = buf.startsWith("\r\n", nl) ? 2 : 1;
        const line = buf.slice(0, nl + eol);
        buf = buf.slice(nl + eol);
        if (stderrFilter(line)) process.stderr.write(line);
      }
    });
    child.stderr.on("end", () => {
      if (buf && stderrFilter(buf)) process.stderr.write(buf);
    });
  }

  const childHangup = () => {
    try {
      child.kill("SIGHUP");
    } catch (_) {
      child.kill("SIGTERM");
    }
  };
  const removeOnExit = onExit(childHangup);

  proxySignals(child);
  const dog = watchdog(child);

  let done = false;
  dog.on("close", (code, signal) => {
    if (done) return;
    child.kill("SIGKILL");
    throw new Error("foreground-child watchdog process died unexpectedly!", {
      cause: {
        pid: dog.pid,
        code,
        signal,
        watchedProcess: { cmd: program, args, pid: child.pid },
      },
    });
  });

  child.on("close", async (code, signal) => {
    if (done) return;
    done = true;
    const result = cleanup(code, signal, { watchdogPid: dog.pid });
    const res = isPromise(result) ? await result : result;
    removeOnExit();
    if (res === false) return;
    else if (typeof res === "string") {
      signal = res;
      code = null;
    } else if (typeof res === "number") {
      code = res;
      signal = null;
    }
    if (signal) {
      setTimeout(() => {}, 2000);
      try {
        process.kill(process.pid, signal);
      } catch (_) {
        process.kill(process.pid, "SIGTERM");
      }
    } else {
      process.exit(code || 0);
    }
  });

  if (process.send) {
    process.removeAllListeners("message");
    child.on("message", (message, sendHandle) => {
      process.send?.(message, sendHandle);
    });
    process.on("message", (message, sendHandle) => {
      child.send(message, sendHandle);
    });
  }

  return child;
}
