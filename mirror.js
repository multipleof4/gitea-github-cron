const syncOrgAvatar = require('./sync-org-avatar');
const { writeFileSync } = require('node:fs');
const { GH_PAT, GITEA_TOKEN, GITEA_URL } = process.env;
const facts = {
  orgsChecked: 0, orgsCreated: 0, orgVisibilityChanged: 0, avatarsUpdated: 0,
  reposFound: 0, mirrorsCreated: 0, repoVisibilityChanged: 0, failures: 0, changes: []
};
const G_API = `https://${GITEA_URL.replace(/^https?:\/\//, '')}/api/v1`;
const headers = {
  GH: { Authorization: `token ${GH_PAT}`, Accept: 'application/vnd.github+json' },
  GT: { Authorization: `token ${GITEA_TOKEN}`, 'Content-Type': 'application/json' }
};

const req = async (url, h, m = 'GET', b = null, allow404 = false) => {
  const res = await fetch(url, { method: m, headers: h, body: b ? JSON.stringify(b) : null });
  if (res.status === 404 && allow404) return null;
  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    const limit = remaining === null ? '' : ` (GitHub rate limit remaining: ${remaining}, reset: ${reset})`;
    throw new Error(`${res.status} ${res.statusText}${limit}: ${(await res.text()).slice(0, 500)}`);
  }
  return m === 'GET' ? res.json() : res;
};

const getPages = async (url) => {
  let p = 1, all = [], d;
  do {
    d = await req(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${p++}`, headers.GH);
    if (!Array.isArray(d)) throw new Error(`Expected a list from ${url}`);
    all.push(...d);
  } while (d?.length === 100);
  return all;
};

(async () => {
  console.log('Starting Mirror Sync...');

  try {
    const gUser = await req(`${G_API}/user`, headers.GT);
    if (!gUser) throw new Error('Cannot auth with Gitea');

    const [ghUserRepos, ghOrgs] = await Promise.all([
      getPages('https://api.github.com/user/repos?affiliation=owner&visibility=all'),
      getPages('https://api.github.com/user/orgs')
    ]);

    let allRepos = [...ghUserRepos];
    let avatarFailures = 0, repoFailures = 0;

    for (const org of ghOrgs) {
      facts.orgsChecked++;
      console.log(`Checking Org: ${org.login}`);
      try {
        const gOrg = await req(`${G_API}/orgs/${org.login}`, headers.GT, 'GET', null, true);
        if (!gOrg) {
          console.log(`Creating Org: ${org.login}`);
          await req(`${G_API}/orgs`, headers.GT, 'POST', { username: org.login, visibility: 'public' });
          facts.orgsCreated++;
          facts.changes.push(`Created org ${org.login}`);
        } else if (gOrg.visibility !== 'public') {
          console.log(`Updating Org Visibility: ${org.login}`);
          await req(`${G_API}/orgs/${org.login}`, headers.GT, 'PATCH', { visibility: 'public' });
          facts.orgVisibilityChanged++;
          facts.changes.push(`Made org ${org.login} public`);
        }

        try {
          if (await syncOrgAvatar(org, G_API, headers.GT)) {
            facts.avatarsUpdated++;
            facts.changes.push(`Updated avatar for ${org.login}`);
            console.log(`Updated Org Avatar: ${org.login}`);
          }
        } catch (e) {
          avatarFailures++;
          console.error(`Failed to sync avatar for ${org.login}:`, e.message);
        }

        const orgRepos = await getPages(`https://api.github.com/orgs/${org.login}/repos?type=all`);
        allRepos.push(...orgRepos);
      } catch (e) {
        throw new Error(`Failed to process org ${org.login}: ${e.message}`);
      }
    }

    console.log(`Processing ${allRepos.length} repositories...`);
    facts.reposFound = allRepos.length;
    for (const r of allRepos) {
      try {
        const owner = r.owner.login;
        const exists = await req(`${G_API}/repos/${owner}/${r.name}`, headers.GT, 'GET', null, true);

        if (!exists) {
          console.log(`Mirroring: ${owner}/${r.name}`);
          const payload = {
            clone_addr: r.clone_url,
            auth_token: GH_PAT,
            mirror: true,
            repo_name: r.name,
            repo_owner: owner,
            service: 'github',
            description: r.description || '',
            private: r.private,
            wiki: true,
            lfs: true,
            releases: true,
            issues: true,
            pull_requests: true,
            labels: true,
            milestones: true,
            mirror_prune: true
          };
          await req(`${G_API}/repos/migrate`, headers.GT, 'POST', payload);
          facts.mirrorsCreated++;
          facts.changes.push(`Mirrored ${owner}/${r.name}`);
        } else if (exists.private !== r.private) {
          console.log(`Updating visibility: ${owner}/${r.name} → ${r.private ? 'private' : 'public'}`);
          await req(`${G_API}/repos/${owner}/${r.name}`, headers.GT, 'PATCH', { private: r.private });
          facts.repoVisibilityChanged++;
          facts.changes.push(`${owner}/${r.name} is now ${r.private ? 'private' : 'public'}`);
        }
      } catch (e) {
        repoFailures++;
        console.error(`Failed to mirror ${r.owner.login}/${r.name}:`, e.message);
      }
    }
    facts.failures = avatarFailures + repoFailures;
    if (avatarFailures || repoFailures) {
      console.error(`Sync finished with ${avatarFailures} avatar failure(s) and ${repoFailures} repository failure(s).`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('Fatal Error:', err);
    facts.fatal = true;
    process.exitCode = 1;
  } finally {
    if (process.env.GITHUB_ACTIONS) writeFileSync('mirror-facts.json', JSON.stringify(facts));
  }
  if (!process.exitCode) console.log('Sync Complete.');
})();
