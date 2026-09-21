const { readFileSync } = require('node:fs');
const { NTFY_TOPIC_URL, RUN_URL, STEP_OUTCOME, TEST_NOTIFICATION, WORKFLOW_KIND } = process.env;

const labels = {
  mirror: ['Mirror sync', 'mirror-facts.json', [
    ['Organizations checked', 'orgsChecked'],
    ['GitHub repositories found', 'reposFound'],
    ['Organizations created', 'orgsCreated'],
    ['Org visibility changes', 'orgVisibilityChanged'],
    ['Org avatars updated', 'avatarsUpdated'],
    ['New mirrors', 'mirrorsCreated'],
    ['Repo visibility changes', 'repoVisibilityChanged'],
    ['Failures', 'failures']
  ]],
  rename: ['Missing-mirror check', 'rename-facts.json', [
    ['Gitea organizations checked', 'orgsChecked'],
    ['GitHub mirrors found', 'mirrorsFound'],
    ['Renamed mirrors', 'renamed'],
    ['Organizations skipped', 'skippedOrgs'],
    ['Failures', 'failures']
  ]]
};

(async () => {
  if (!NTFY_TOPIC_URL || !labels[WORKFLOW_KIND]) throw new Error('Notification URL or workflow kind missing');
  const test = TEST_NOTIFICATION === 'true';
  const [label, file, fields] = labels[WORKFLOW_KIND];
  const title = test ? 'Gitea backup notification test' : `${label}: ${STEP_OUTCOME === 'success' ? 'succeeded' : 'failed'}`;
  const lines = test ? ['Notification-only test. No mirror or rename ran.'] : [];

  if (!test) {
    try {
      const facts = JSON.parse(readFileSync(file, 'utf8'));
      lines.push(...fields.map(([name, key]) => `${name}: ${facts[key] ?? 0}`));
      const changes = facts.changes || [];
      if (changes.length) lines.push('Changes:', ...changes.slice(0, 10));
      if (changes.length > 10) lines.push(`...and ${changes.length - 10} more; see run logs.`);
      if (facts.fatal) lines.push('Fatal error; see run logs.');
    } catch {
      lines.push('No run summary available; see run logs.');
    }
  }

  if (RUN_URL) lines.push(`Run: ${RUN_URL}`);
  const res = await fetch(NTFY_TOPIC_URL, {
    method: 'POST',
    headers: { Priority: '2', Title: title, ...(RUN_URL && { Click: RUN_URL }) },
    body: lines.join('\n'),
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`ntfy returned HTTP ${res.status}`);
  console.log(`ntfy notification sent: ${title}`);
})().catch(error => {
  console.error(`Notification failed: ${error.message}`);
  process.exitCode = 1;
});
