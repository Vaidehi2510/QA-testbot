// Runs the real coverage logic against mock data — no GitHub, no Slack, no setup.

const fs = require('fs');
const path = require('path');
const { buildCoverage } = require('./core.js');
const { newPrMessage, weeklyReportMessage } = require('./slack.js');
const { generatePlan } = require('./planner.js');

const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'qa-config.json'), 'utf8'));
const roster = JSON.parse(fs.readFileSync(path.join(root, 'roster.json'), 'utf8'));
const prs = JSON.parse(fs.readFileSync(path.join(root, 'mock', 'sample-prs.json'), 'utf8'));

const c = buildCoverage(prs, roster, config);

console.log(`\n  QA coverage demo — release ${c.release}`);
console.log('  Goal: every intern reviews every PR\n');

console.log('  By PR:');
for (const p of c.prRows) {
  const miss = p.missing.length ? `missing: ${p.missing.join(', ')}` : 'COMPLETE';
  console.log(`    #${p.number}  ${p.title}`);
  console.log(`          reviewed by: ${p.reviewedBy.join(', ') || '—'}   ${miss}`);
}

console.log('\n  By intern:');
for (const i of c.interns) {
  console.log(`    ${i.github}: done ${i.done.length}/${c.totalPRs}, missing ${i.missing.map((n) => '#' + n).join(', ') || 'none'}`);
}

console.log(`\n  ${c.fullyCovered} of ${c.totalPRs} PRs reviewed by everyone.\n`);

console.log('  ---- Friday report posted to Slack: ----\n');
console.log(weeklyReportMessage(c).split('\n').map((l) => '    ' + l).join('\n'));

console.log('\n  ---- Example "new PR" alert posted to Slack: ----\n');
console.log(newPrMessage(c.prRows.find((p) => p.number === 104), roster).split('\n').map((l) => '    ' + l).join('\n'));
console.log('');

const rules = JSON.parse(fs.readFileSync(path.join(root, 'qa-rules.json'), 'utf8'));
const examplePr = prs.find((p) => p.number === 102);
console.log('  ---- Auto-generated QA plan for PR #102 (posted to GitHub + Slack): ----\n');
console.log(generatePlan(examplePr, rules).markdown.split('\n').map((l) => '    ' + l).join('\n'));
console.log('');
