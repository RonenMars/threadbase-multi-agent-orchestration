// Prints "true" when every changed file (one per line on stdin) is listed in the
// paths file given as the first argument, so the suite can be skipped.
// An entry is an exact path, or "dir/**" for everything under dir.

const { readFileSync } = require('node:fs');

const entries = readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

const changed = readFileSync(0, 'utf8').split('\n').filter(Boolean);

const listed = (file) =>
  entries.some((e) => (e.endsWith('/**') ? file.startsWith(e.slice(0, -2)) : file === e));

console.log(changed.length > 0 && changed.every(listed));
