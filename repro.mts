import {createPiRunner} from './workflows/review/lib/dispatch-runner-pi.ts';
const runner = await createPiRunner();
try {
  const result = await runner({name: 't', model: 'gemini-3.8-flash', prompt: 'say hi', cwd: '.', maxTurns: 1, timeoutMs: 30000});
  console.log('RESULT', JSON.stringify(result).slice(0, 400));
} catch (e) { console.log('THREW:', (e as Error).message); }
