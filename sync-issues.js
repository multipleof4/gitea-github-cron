const { writeFileSync } = require('node:fs');
const { github, ghHeaders, gtHeaders, enc, request, pages, listMirrors } = require('./gitea-mirrors');
const facts = {
  mirrorsChecked: 0, issuesFound: 0, created: 0, updated: 0,
  commentsCreated: 0, commentsUpdated: 0, failures: 0, changes: []
};
const who = user => user ? `[@${user.login}](${user.html_url})` : '@ghost';
const quote = (header, body) => body ? `> ${header}\n\n${body}` : `> ${header}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const names = labels => labels.map(label => label.name).sort().join('\n');

// Gitea numbers must match GitHub's so #N references in commits and comments stay correct.
// PR numbers are left as gaps, since mirrors have no pull requests.
const syncIssues = async ({ gh, gtRepo }, ghIssues, count) => {
  const [gtIssues, gtLabels] = await Promise.all([
    pages(`${gtRepo}/issues?state=all&type=issues`, gtHeaders, 'limit'),
    pages(`${gtRepo}/labels`, gtHeaders, 'limit')
  ]);
  const byNumber = new Map(gtIssues.map(issue => [issue.number, issue]));
  const labelIds = new Map(gtLabels.map(label => [label.name, label.id]));
  const ids = async labels => {
    for (const { name, color, description } of labels.filter(label => !labelIds.has(label.name))) {
      const made = await request(`${gtRepo}/labels`, gtHeaders, 'POST', { name, color: `#${color}`, description: description || '' });
      labelIds.set(name, made.id);
    }
    return labels.map(label => labelIds.get(label.name));
  };
  // Gitea never reuses a deleted issue's number, so an issue that lands on a GitHub gap
  // (deleted, transferred, or a discussion) is deleted and made again, leaving the same gap
  const create = async (issue, n) => {
    for (;;) {
      const { number } = await request(`${gtRepo}/issues`, gtHeaders, 'POST', issue);
      if (number === n) return;
      await request(`${gtRepo}/issues/${number}`, gtHeaders, 'DELETE');
      if (number > n) throw new Error(`Gitea is already past #${n}, so numbers can't line up`);
    }
  };
  const link = n => `https://github.com/${gh.owner}/${gh.name}/issues/${n}`;
  // One-time cleanup: PRs used to be copied as issues with a `pull request` label
  for (const gt of gtIssues.filter(gt => gt.body.includes(`opened pull request [GitHub #${gt.number}](${link(gt.number)})`))) {
    await request(`${gtRepo}/issues/${gt.number}`, gtHeaders, 'DELETE');
    byNumber.delete(gt.number);
    console.log(`Removed PR copy ${gtRepo.split('/repos/')[1]}#${gt.number}`);
  }
  const prLabel = gtLabels.find(label => label.name === 'pull request' && label.description === 'Pull request on GitHub');
  if (prLabel) await request(`${gtRepo}/labels/${prLabel.id}`, gtHeaders, 'DELETE');
  let top = Math.max(0, ...byNumber.keys());

  for (const issue of ghIssues.sort((a, b) => a.number - b.number)) {
    const n = issue.number;
    const header = `${who(issue.user)} opened issue [GitHub #${n}](${link(n)}) on ${issue.created_at.slice(0, 10)}`;
    const want = { title: issue.title, body: quote(header, issue.body), state: issue.state };
    const gt = byNumber.get(n);

    if (!gt) {
      if (n < top) throw new Error(`Gitea has no #${n} and can't reuse the number`);
      await create({ title: want.title, body: want.body, closed: want.state === 'closed', labels: await ids(issue.labels) }, n);
      top = n;
      count.created++;
      continue;
    }

    if (!gt.body.includes(`(${link(n)})`)) throw new Error(`Gitea #${n} wasn't made by this sync`);
    let changed = false;
    if (Object.entries(want).some(([k, v]) => gt[k] !== v)) {
      await request(`${gtRepo}/issues/${n}`, gtHeaders, 'PATCH', want);
      changed = true;
    }
    if (names(gt.labels) !== names(issue.labels)) {
      await request(`${gtRepo}/issues/${n}/labels`, gtHeaders, 'PUT', { labels: await ids(issue.labels) });
      changed = true;
    }
    if (changed) count.updated++;
  }
};

// Conversation comments on issues and PRs; the GitHub comment link in each header maps them back
const syncComments = async ({ gh, gtRepo }, prs, count) => {
  const [ghComments, gtComments] = await Promise.all([
    pages(`${github}/repos/${enc(gh.owner, gh.name)}/issues/comments?sort=created&direction=asc`, ghHeaders, 'per_page'),
    pages(`${gtRepo}/issues/comments`, gtHeaders, 'limit')
  ]);
  const mirrored = new Map(gtComments.map(comment =>
    [comment.body.split('\n', 1)[0].match(/#issuecomment-(\d+)\)/)?.[1], comment]
  ));
  for (const comment of ghComments) {
    const n = Number(comment.issue_url.split('/').pop());
    if (prs.has(n)) continue;
    const body = quote(`${who(comment.user)} commented on [${comment.created_at.slice(0, 10)}](${comment.html_url})`, comment.body);
    const gt = mirrored.get(String(comment.id));
    if (!gt) {
      await request(`${gtRepo}/issues/${n}/comments`, gtHeaders, 'POST', { body });
      count.commentsCreated++;
    } else if (gt.body !== body) {
      await request(`${gtRepo}/issues/comments/${gt.id}`, gtHeaders, 'PATCH', { body });
      count.commentsUpdated++;
    }
  }
};

(async () => {
  const mirrors = await listMirrors();
  facts.mirrorsChecked = mirrors.length;
  console.log(`Checking issues for ${mirrors.length} GitHub mirror(s)...`);

  for (const mirror of mirrors) {
    const { gh, name } = mirror;
    const count = { created: 0, updated: 0, commentsCreated: 0, commentsUpdated: 0 };
    try {
      // GitHub lists PRs as issues too
      const all = await pages(`${github}/repos/${enc(gh.owner, gh.name)}/issues?state=all`, ghHeaders, 'per_page', true);
      if (!all?.length) continue;
      const issues = all.filter(issue => !issue.pull_request);
      const prs = new Set(all.filter(issue => issue.pull_request).map(issue => issue.number));
      facts.issuesFound += issues.length;
      await syncIssues(mirror, issues, count);
      if (issues.some(issue => issue.comments)) await syncComments(mirror, prs, count);
    } catch (error) {
      facts.failures++;
      console.error(`Failed to sync issues for ${name}: ${error.message}`);
    } finally {
      for (const [k, v] of Object.entries(count)) facts[k] += v;
      const parts = [
        count.created && `+${plural(count.created, 'issue')}`,
        count.updated && `${count.updated} updated`,
        count.commentsCreated && `+${plural(count.commentsCreated, 'comment')}`,
        count.commentsUpdated && `${plural(count.commentsUpdated, 'comment')} updated`
      ].filter(Boolean);
      if (parts.length) {
        facts.changes.push(`${name}: ${parts.join(', ')}`);
        console.log(`${name}: ${parts.join(', ')}`);
      }
    }
  }

  console.log(`Created ${facts.created} issue(s), ${facts.commentsCreated} comment(s); updated ${facts.updated} issue(s), ${facts.commentsUpdated} comment(s); ${facts.failures} failure(s).`);
  if (facts.failures) process.exitCode = 1;
})().catch(error => {
  console.error(`Fatal: ${error.message}`);
  facts.fatal = true;
  process.exitCode = 1;
}).finally(() => {
  if (process.env.GITHUB_ACTIONS) writeFileSync('issue-facts.json', JSON.stringify(facts));
});
