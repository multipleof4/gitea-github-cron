const { GH_PAT, GITEA_TOKEN, GITEA_URL } = process.env;
if (![GH_PAT, GITEA_TOKEN, GITEA_URL].every(Boolean)) {
  throw new Error('GH_PAT, GITEA_TOKEN, and GITEA_URL are required');
}

const gitea = `https://${GITEA_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')}/api/v1`;
const github = 'https://api.github.com';
const ghHeaders = { Authorization: `token ${GH_PAT}`, Accept: 'application/vnd.github+json' };
const gtHeaders = { Authorization: `token ${GITEA_TOKEN}`, 'Content-Type': 'application/json' };
const key = value => value.toLowerCase();
const enc = (...parts) => parts.map(encodeURIComponent).join('/');

const request = async (url, headers, method = 'GET', body, missingOK = false) => {
  const res = await fetch(url, {
    method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30_000)
  });
  if (res.status === 404 && missingOK) return null;
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
};

const pages = async (url, headers, sizeKey, missingOK = false) => {
  const all = [];
  for (let page = 1; page <= 1000; page++) {
    const next = new URL(url);
    next.searchParams.set(sizeKey, '100');
    next.searchParams.set('page', String(page));
    const batch = await request(next, headers, 'GET', null, missingOK);
    if (batch === null) return null;
    if (!Array.isArray(batch)) throw new Error(`Expected an array from ${next}`);
    if (!batch.length) return all;
    all.push(...batch);
  }
  throw new Error(`Pagination limit reached for ${url}`);
};

const source = repo => {
  try {
    const url = new URL(repo.original_url.replace(/^git@github\.com:/i, 'https://github.com/'));
    const parts = url.pathname.replace(/\.git\/?$/i, '').split('/').filter(Boolean);
    return url.hostname === 'github.com' && parts.length === 2 ? { owner: parts[0], name: parts[1] } : null;
  } catch {
    return null;
  }
};

// Pull mirrors of GitHub repos owned by the Gitea user or its orgs.
// Frozen mirrors (sync interval 0, e.g. renamed -goneN ones) are left out.
const listMirrors = async () => {
  const [gtUser, gtOrgs] = await Promise.all([
    request(`${gitea}/user`, gtHeaders),
    pages(`${gitea}/user/orgs`, gtHeaders, 'limit')
  ]);
  const owners = [gtUser.login, ...gtOrgs.map(org => org.username || org.name)];
  const ownerKeys = new Set(owners.map(key));
  const repos = (await Promise.all(owners.map((owner, i) =>
    pages(i ? `${gitea}/orgs/${enc(owner)}/repos` : `${gitea}/user/repos`, gtHeaders, 'limit')
  ))).flat();
  return [...new Map(repos.map(repo => [repo.id, repo])).values()]
    .filter(repo => repo.mirror && repo.original_url && !repo.archived && repo.mirror_interval !== '0s')
    .filter(repo => ownerKeys.has(key(repo.owner.login)))
    .map(repo => ({
      repo, gh: source(repo), name: `${repo.owner.login}/${repo.name}`,
      gtRepo: `${gitea}/repos/${enc(repo.owner.login, repo.name)}`
    }))
    .filter(mirror => mirror.gh);
};

module.exports = { github, ghHeaders, gtHeaders, enc, request, pages, listMirrors };
