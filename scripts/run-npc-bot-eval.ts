import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runBotMatchEval, writeBotEvalArtifacts } from '../src/npc-brain/bot-eval';

const projectRoot = resolve(process.argv[2] ?? '../..');
const matches = Number(process.argv[3] ?? 100);
const result = runBotMatchEval(matches);
if (!result.report.differentiation.meaningful) {
  throw new Error('NPC bot behavior differentiation gate failed');
}
const artifacts = writeBotEvalArtifacts(projectRoot, result);
const balancePath = resolve(projectRoot, '.forgeax/games/paopaotang/balance.md');
if (existsSync(balancePath)) {
  const start = '<!-- forgeax:npc-bot-eval:start -->';
  const end = '<!-- forgeax:npc-bot-eval:end -->';
  const block = `${start}

## NPC Brain npc_text

- npc_text\`${result.report.matches}\` npc_textseed \`${result.report.seed}\`npc_text
- aggressive npc_text ${result.report.aggressive.wins} npc_textconservative npc_text ${result.report.conservative.wins} npc_text ${result.report.aggressive.draws} npc_text
- npc_text gatenpc_text ${(result.report.differentiation.bubbleRateDelta * 100).toFixed(1)}ppnpc_text ${(result.report.differentiation.nearRateDelta * 100).toFixed(1)}ppnpc_text ${(result.report.differentiation.itemRateDelta * 100).toFixed(1)}ppnpc_text
- npc_text\`${artifacts.reportPath}\`npc_text
- Replay-as-Eval ledgernpc_text\`${artifacts.replayPath}\`npc_text

${end}`;
  const current = readFileSync(balancePath, 'utf8').trimEnd();
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  writeFileSync(balancePath, `${pattern.test(current) ? current.replace(pattern, block) : `${current}\n\n${block}`}\n`);
}
process.stdout.write(`${JSON.stringify({ ...result.report, artifacts }, null, 2)}\n`);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
