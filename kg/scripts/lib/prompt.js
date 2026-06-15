/**
 * Interactive readline prompts for CLI mode.
 * Skill mode uses AskUserQuestion instead — never reaches these.
 */

import { createInterface } from 'node:readline';

export async function ask(question, defaultValue) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = defaultValue
    ? `${question} [${defaultValue}]: `
    : `${question}: `;
  return new Promise(res => {
    rl.question(prompt, answer => {
      rl.close();
      res(answer.trim() || defaultValue || '');
    });
  });
}

export async function askChoice(question, choices, defaultIdx = 0) {
  console.log(`\n${question}`);
  choices.forEach((c, i) => {
    const marker = i === defaultIdx ? '★' : ' ';
    console.log(`  ${marker} ${i + 1}. ${c}`);
  });
  const answer = await ask(`Choose 1-${choices.length}`, String(defaultIdx + 1));
  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= choices.length) return choices[defaultIdx];
  return choices[idx];
}

export async function askYesNo(question, defaultYes = true) {
  const def = defaultYes ? 'y' : 'n';
  const answer = await ask(`${question} (y/n)`, def);
  return /^y/i.test(answer);
}

export async function askMultiSelect(question, choices, defaults = []) {
  console.log(`\n${question}`);
  console.log(`Defaults marked with ★. Enter comma-separated numbers, or blank to accept defaults.`);
  choices.forEach((c, i) => {
    const marker = defaults.includes(c) ? '★' : ' ';
    console.log(`  ${marker} ${i + 1}. ${c}`);
  });
  const answer = await ask('Choose (e.g. "1,3")', defaults.map(d => String(choices.indexOf(d) + 1)).join(','));
  if (!answer.trim()) return defaults;
  const indices = answer.split(',').map(s => parseInt(s.trim(), 10) - 1).filter(i => !isNaN(i) && i >= 0 && i < choices.length);
  return indices.map(i => choices[i]);
}
