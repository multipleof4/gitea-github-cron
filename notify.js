const { readFileSync } = require('node:fs');
const { NTFY_TOPIC_URL, RUN_URL, STEP_OUTCOME, TEST_NOTIFICATION, WORKFLOW_KIND } = process.env;

// [noun, key]: shown as "**n** noun(s)" and hidden when zero
const labels = {
  mirror: ['Mirror sync', 'mirror-facts.json', [
    ['org', 'orgsChecked'],
    ['repo', 'reposFound'],
    ['created org', 'orgsCreated'],
    ['org visibility change', 'orgVisibilityChanged'],
    ['new mirror', 'mirrorsCreated'],
    ['repo visibility change', 'repoVisibilityChanged'],
    ['failure', 'failures']
  ]],
  rename: ['Missing-mirror check', 'rename-facts.json', [
    ['org', 'orgsChecked'],
    ['mirror', 'mirrorsFound'],
    ['renamed mirror', 'renamed'],
    ['skipped org', 'skippedOrgs'],
    ['failure', 'failures']
  ]]
};
const md = text => String(text).replace(/[\\`*_[\]#]/g, '\\$&');

(async () => {
  if (!NTFY_TOPIC_URL || !labels[WORKFLOW_KIND]) throw new Error('Notification URL or workflow kind missing');
  const test = TEST_NOTIFICATION === 'true', ok = STEP_OUTCOME === 'success';
  const [label, file, fields] = labels[WORKFLOW_KIND];
  const title = test ? 'Gitea backup notification test' : `${label}: ${ok ? 'succeeded' : 'failed'}`;
  const lines = test ? ['Notification-only test. No mirror or rename ran.'] : [];

  if (!test) {
    try {
      const facts = JSON.parse(readFileSync(file, 'utf8'));
      const counts = fields.filter(([, k]) => facts[k]).map(([noun, k]) => `**${facts[k]}** ${noun}${facts[k] === 1 ? '' : 's'}`);
      if (counts.length) lines.push(counts.join(' · '));
      const changes = facts.changes || [];
      if (changes.length) lines.push('', ...changes.slice(0, 10).map(c => `- ${md(c)}`));
      if (changes.length > 10) lines.push(`- *…and ${changes.length - 10} more; see run logs.*`);
      if (facts.fatal) lines.push('', '**Fatal error**; see run logs.');
    } catch {
      lines.push('No run summary available; see run logs.');
    }
  }

  const res = await fetch(NTFY_TOPIC_URL, {
    method: 'POST',
    headers: {
      Priority: '2', Title: title, Markdown: 'yes',
      Tags: test ? 'test_tube' : ok ? 'white_check_mark' : 'x',
      ...(RUN_URL && { Actions: `view, Open run, ${RUN_URL}` })
    },
    body: lines.join('\n') || 'Nothing to report.',
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`ntfy returned HTTP ${res.status}`);
  console.log(`ntfy notification sent: ${title}`);
})().catch(error => {
  console.error(`Notification failed: ${error.message}`);
  process.exitCode = 1;
});
