// Contatore dei controlli per run-all.sh: avvolge assert/strict e conta ogni
// asserzione superata; ogni script stampa alla fine una riga
//   RISULTATO passati=N falliti=M
// che run-all.sh legge per la tabella finale.
const base = require('assert/strict');

const counter = { passed: 0, failed: 0 };

const wrap = fn => (...args) => {
  fn(...args);
  counter.passed += 1;
};

const assert = wrap(base);
for (const k of Object.keys(base)) {
  assert[k] = typeof base[k] === 'function' && k !== 'AssertionError' ? wrap(base[k]) : base[k];
}

const report = (extraPassed = 0, extraFailed = 0) => {
  console.log(`RISULTATO passati=${counter.passed + extraPassed} falliti=${counter.failed + extraFailed}`);
};

module.exports = { assert, counter, report };
