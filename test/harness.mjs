// SPDX-License-Identifier: GPL-3.0-or-later
/** Minimal assertion harness shared by the deterministic suite. */

let pass = 0;
let fail = 0;
let skip = 0;

export function section(name) {
  console.log(`\n${name}`);
}

export function check(name, condition, extra = "") {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

export function skipped(name, why) {
  skip++;
  console.log(`  SKIP  ${name} (${why})`);
}

export function note(text) {
  console.log(`        ${text}`);
}

export const near = (a, b, eps = 1e-9) => typeof a === "number" && Math.abs(a - b) < eps;

/** Prints the tally and exits non-zero on any failure. */
export function report(label) {
  console.log(`\n${"=".repeat(52)}`);
  console.log(`${label}: ${pass} pass, ${fail} fail, ${skip} skip`);
  process.exit(fail === 0 ? 0 : 1);
}
