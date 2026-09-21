const { GH_PAT, GITEA_TOKEN, GITEA_URL } = process.env;
if (![GH_PAT, GITEA_TOKEN, GITEA_URL].every(Boolean)) {
  throw new Error('GH_PAT, GITEA_TOKEN, and GITEA_URL are required');
}

const gitea = `https://${GITEA_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')}/api/v1`;
const github = 'https://api.github.com';
const ghHeaders = { Authorization: `token ${GH_PAT}`, Accept: 'application/vnd.github+json' };
const gtHeaders = { Authorization: `token ${GITEA_TOKEN}`, 'Content-Type': 'application/json' };
const key = value => value.toLowerCase();

const request = async (url, headers, method = 'GET', body, missingOK = false) => {
  const res = await fetch(url, {
    method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30_000)
  });
  if (res.headers.has('x-github-sso')) throw new Error(`GitHub SSO authorization required for ${url}`);
  if (res.status === 404 && missingOK) return null;
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return method === 'GET' || method === 'PATCH' ? res.json() : res;
};

const pages = async (url, headers, sizeKey) => {
  const all = [];
  for (let page = 1; page <= 1000; page++) {
    const next = new URL(url);
    next.searchParams.set(sizeKey, '100');
    next.searchParams.set('page', String(page));
    const batch = await request(next, headers);
    if (!Array.isArray(batch)) throw new Error(`Expected an array from ${next}`);
    if (!batch.length) return all;
    all.push(...batch);
  }
  throw new Error(`Pagination limit reached for ${url}`);
};

const source = repo => {
  if (!repo.mirror || !repo.original_url) return null;
  try {
    const url = new URL(repo.original_url.replace(/^git@github\.com:/i, 'https://github.com/'));
    if (url.hostname !== 'github.com') return null;
    const parts = url.pathname.replace(/\.git\/?$/i, '').split('/').filter(Boolean);
    if (parts.length !== 2 || key(parts[0]) !== key(repo.owner.login)) return null;
    return { owner: parts[0], name: parts[1] };
  } catch {
    return null;
  }
};

const goneName = (name, number) => {
  const suffix = `-gone${number}`;
  return `${name.slice(0, 100 - suffix.length)}${suffix}`;
};

const alreadyGone = (name, original) =>
  key(name) !== key(original) && /-gone[1-9]\d*$/i.test(name);

(async () => {
  const auth = await fetch(`${github}/user`, { headers: ghHeaders, signal: AbortSignal.timeout(30_000) });
  if (auth.headers.has('x-github-sso')) throw new Error('GH_PAT needs GitHub SSO authorization');
  if (!auth.ok) throw new Error(`GitHub authentication failed: ${auth.status}`);
  const scopes = auth.headers.get('x-oauth-scopes')?.split(',').map(scope => scope.trim()) || [];
  if (!scopes.includes('repo')) {
    throw new Error('GH_PAT must be a classic GitHub token with repo scope to check private mirrors safely');
  }
  const ghUser = await auth.json();
  const [gtUser, ghOrgs, gtOrgs, ghPersonal, gtPersonal] = await Promise.all([
    request(`${gitea}/user`, gtHeaders),
    pages(`${github}/user/orgs`, ghHeaders, 'per_page'),
    pages(`${gitea}/user/orgs`, gtHeaders, 'limit'),
    pages(`${github}/user/repos?affiliation=owner&visibility=all`, ghHeaders, 'per_page'),
    pages(`${gitea}/user/repos`, gtHeaders, 'limit')
  ]);

  if (key(gtUser.login) !== key(ghUser.login)) {
    throw new Error(`GitHub user ${ghUser.login} does not match Gitea user ${gtUser.login}`);
  }
  const personal = ghPersonal.filter(repo => key(repo.owner.login) === key(ghUser.login));
  if (!Number.isInteger(ghUser.public_repos) || !Number.isInteger(ghUser.owned_private_repos)) {
    throw new Error('GitHub did not report both public and owned private repository counts');
  }
  const expected = ghUser.public_repos + ghUser.owned_private_repos;
  if (personal.length < expected) {
    throw new Error(`GitHub returned ${personal.length} personal repos, but reports ${expected}; refusing to rename`);
  }

  const ghOrgNames = new Set(ghOrgs.map(org => key(org.login)));
  const groups = [{ owner: gtUser.login, repos: gtPersonal, ghRepos: personal }];
  for (const org of gtOrgs) {
    const owner = org.username || org.name;
    if (ghOrgNames.has(key(owner))) {
      const [ghOrg, ghRepos, gtRepos] = await Promise.all([
        request(`${github}/orgs/${encodeURIComponent(owner)}`, ghHeaders),
        pages(`${github}/orgs/${encodeURIComponent(owner)}/repos?type=all`, ghHeaders, 'per_page'),
        pages(`${gitea}/orgs/${encodeURIComponent(owner)}/repos`, gtHeaders, 'limit')
      ]);
      const expected = ghOrg.public_repos + ghOrg.total_private_repos;
      if (Number.isFinite(expected) && ghRepos.length < expected) {
        throw new Error(`GitHub returned ${ghRepos.length} repos for ${owner}, but reports ${expected}; refusing to rename`);
      }
      groups.push({ owner, repos: gtRepos, ghRepos });
    } else {
      const ghOrg = await request(`${github}/orgs/${encodeURIComponent(owner)}`, ghHeaders, 'GET', null, true);
      if (ghOrg) {
        console.log(`Skipping ${owner}: GitHub organization exists but is not listed for this token`);
        continue;
      }
      const gtRepos = await pages(`${gitea}/orgs/${encodeURIComponent(owner)}/repos`, gtHeaders, 'limit');
      groups.push({ owner, repos: gtRepos, ghRepos: [] });
    }
  }

  let renamed = 0, failures = 0;
  for (const { owner, repos, ghRepos } of groups) {
    const live = new Set(ghRepos.map(repo => key(repo.name)));
    const occupied = new Set(repos.map(repo => key(repo.name)));
    for (const repo of repos) {
      const remote = source(repo);
      if (!remote || key(repo.owner.login) !== key(owner) || live.has(key(remote.name))) continue;
      if (alreadyGone(repo.name, remote.name)) continue;

      try {
        const exists = await request(
          `${github}/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.name)}`,
          ghHeaders, 'GET', null, true
        );
        if (exists) continue;

        let number = 1, name;
        do name = goneName(repo.name, number++); while (occupied.has(key(name)));
        const updated = await request(
          `${gitea}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo.name)}`,
          gtHeaders, 'PATCH', { name }
        );
        if (key(updated.name) !== key(name)) throw new Error('Gitea did not return the requested name');
        occupied.delete(key(repo.name));
        occupied.add(key(name));
        renamed++;
        console.log(`Renamed ${owner}/${repo.name} to ${owner}/${name}`);
      } catch (error) {
        failures++;
        console.error(`Failed to check or rename ${owner}/${repo.name}: ${error.message}`);
      }
    }
  }
  console.log(`Renamed ${renamed} missing GitHub mirror(s); ${failures} failure(s).`);
  if (failures) process.exitCode = 1;
})().catch(error => {
  console.error(`Fatal: ${error.message}`);
  process.exitCode = 1;
});
