const { GH_PAT, GITEA_TOKEN, GITEA_URL } = process.env;
const G_API = `https://${GITEA_URL.replace(/^https?:\/\//, '')}/api/v1`;
const headers = {
  GH: { Authorization: `token ${GH_PAT}`, Accept: 'application/vnd.github+json' },
  GT: { Authorization: `token ${GITEA_TOKEN}`, 'Content-Type': 'application/json' }
};

const req = async (url, h, m = 'GET', b = null) => {
  try {
    const res = await fetch(url, { method: m, headers: h, body: b ? JSON.stringify(b) : null });
    if (!res.ok && m !== 'GET') {
      const txt = await res.text();
      throw new Error(`${res.status} ${res.statusText}: ${txt}`);
    }
    return res.ok ? (m === 'GET' ? res.json() : res) : null;
  } catch (e) {
    if (m !== 'GET') throw e; // Re-throw for non-GET to handle in loop
    return null;
  }
};

const getPages = async (url) => {
  let p = 1, all = [], d;
  do {
    d = await req(`${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${p++}`, headers.GH);
    if (Array.isArray(d)) all.push(...d);
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
    
    for (const org of ghOrgs) {
      console.log(`Checking Org: ${org.login}`);
      try {
        const gOrg = await req(`${G_API}/orgs/${org.login}`, headers.GT);
        if (!gOrg) {
          console.log(`Creating Org: ${org.login}`);
          await req(`${G_API}/orgs`, headers.GT, 'POST', { username: org.login, visibility: 'private' });
        }
        const orgRepos = await getPages(`https://api.github.com/orgs/${org.login}/repos?type=all`);
        allRepos.push(...orgRepos);
      } catch (e) {
        console.error(`Failed to process org ${org.login}:`, e.message);
      }
    }

    console.log(`Processing ${allRepos.length} repositories...`);
    for (const r of allRepos) {
      try {
        const owner = r.owner.login;
        const exists = await req(`${G_API}/repos/${owner}/${r.name}`, headers.GT);
        
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
        }
      } catch (e) {
        console.error(`Failed to mirror ${r.owner.login}/${r.name}:`, e.message);
      }
    }
  } catch (err) {
    console.error('Fatal Error:', err);
    process.exit(1);
  }
  console.log('Sync Complete.');
})();
