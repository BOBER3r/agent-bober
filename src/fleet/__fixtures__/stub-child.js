#!/usr/bin/env node
// stub-child.js — a lightweight fixture invoked via process.execPath in tests.
// Reads argv to choose behavior:
//   node stub-child.js exit <code>    → exits with the given numeric code
//   node stub-child.js sleep <ms>     → sleeps for <ms> milliseconds (to trip timeouts)
//   node stub-child.js version        → prints "stub 0.0.0" and exits 0
//   node stub-child.js echo <message> → prints message to stdout and exits 0
// Any other argv → exits 1

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === "exit") {
  const code = parseInt(args[1] ?? "0", 10);
  process.exit(isNaN(code) ? 1 : code);
} else if (cmd === "sleep") {
  const ms = parseInt(args[1] ?? "5000", 10);
  setTimeout(() => {
    process.exit(0);
  }, isNaN(ms) ? 5000 : ms);
} else if (cmd === "version" || args.includes("--version")) {
  process.stdout.write("stub 0.0.0\n");
  process.exit(0);
} else if (cmd === "echo") {
  process.stdout.write((args.slice(1).join(" ") ?? "") + "\n");
  process.exit(0);
} else {
  process.stderr.write(`stub-child: unknown command: ${cmd ?? "(none)"}\n`);
  process.exit(1);
}
