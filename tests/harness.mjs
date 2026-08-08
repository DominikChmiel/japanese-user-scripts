import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOTS = path.join(ROOT, 'snapshots');

/**
 * Boot a userscript inside a jsdom window, the way Tampermonkey would. `setup`
 * runs against the window before the script does, for stubbing the browser APIs
 * jsdom lacks (fetch) or that the script samples at boot (Date).
 */
export function runUserscript(scriptName, { html, url, setup }) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;

  // The scripts poll with setInterval to survive SPA/Turbo navigation. Collect
  // the callbacks instead of letting them keep the test process alive.
  const timers = [];
  window.setInterval = (fn) => {
    timers.push(fn);
    return timers.length;
  };

  if (setup) setup(window);

  window.eval(fs.readFileSync(path.join(ROOT, scriptName), 'utf8'));
  return { dom, window, tick: () => timers.forEach((fn) => fn()) };
}

/** Wait for the scripts' requestAnimationFrame-batched renders to flush. */
export const flush = () => new Promise((resolve) => setTimeout(resolve, 60));

export function createChecker(title) {
  let failures = 0;
  console.log('\n=== ' + title + ' ===');
  const check = (name, condition, extra = '') => {
    if (condition) {
      console.log('  ok   ' + name);
    } else {
      failures++;
      console.log('  FAIL ' + name + (extra ? '  ::  ' + extra : ''));
    }
  };
  check.summary = () => {
    console.log(failures ? `  -> ${failures} failure(s)` : '  -> all pass');
    return failures;
  };
  return check;
}
