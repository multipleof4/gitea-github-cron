const { writeFileSync } = require('node:fs');
const { GH_PAT, GITEA_TOKEN, GITEA_URL } = process.env;
if (![GH_PAT, GITEA_TOKEN, GITEA_URL].every(Boolean)) {
  throw new Error('GH_PAT, GITEA_TOKEN, and GITEA_URL are required');
}

const gitea = `https://${GITEA_URL.replace(/^https?:\/\//, '').replace(/\/$/, '')}/api/v1`;
const github = 'https://api.github.com';
const ghHeaders = { Authorization: `token ${GH_PAT}`, Accept: 'application/vnd.github+json' };
const gtHeaders = { Authorization: `token ${GITEA_TOKEN}`, 'Content-Type': 'application/json' };
const facts = {
  mirrorsChecked: 0, releasesFound: 0, created: 0, updated: 0, assetsUploaded: 0,
  unsyncedTags: 0, failures: 0, changes: []
};
const key = value => value.toLowerCase();
const enc = (...parts) => parts.map(encodeURIComponent).join('/');
const transferTimeout = () => AbortSignal.timeout(30 * 60_000);

const request = async (url, headers, method = 'GET', body, missingOK = false) => {
  const res = await fetch(url, {
    method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30_000)
  });
  if (res.status === 404 && missingOK) return null;
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
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

// Pipe the GitHub download straight into Gitea's raw upload, so assets never touch disk or memory
const copyAsset = async (gh, gtRepo, releaseId, asset) => {
  const download = await fetch(`${github}/repos/${enc(gh.owner, gh.name)}/releases/assets/${asset.id}`, {
    headers: { ...ghHeaders, Accept: 'application/octet-stream' }, signal: transferTimeout()
  });
  if (!download.ok) throw new Error(`download ${asset.name}: ${download.status}`);
  const upload = await fetch(`${gtRepo}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`, {
    method: 'POST', body: download.body, duplex: 'half', signal: transferTimeout(),
    headers: { Authorization: gtHeaders.Authorization, 'Content-Type': 'application/octet-stream' }
  });
  if (upload.status === 413) throw new Error(`${asset.name} (${asset.size} bytes) is over Gitea's [repository.release] FILE_MAX_SIZE`);
  if (!upload.ok) throw new Error(`upload ${asset.name}: ${upload.status} ${(await upload.text()).slice(0, 300)}`);
};

const syncRelease = async ({ repo, gh }, rel, existing) => {
  const gtRepo = `${gitea}/repos/${enc(repo.owner.login, repo.name)}`;
  const where = `${repo.owner.login}/${repo.name}@${rel.tag_name}`;
  const want = { name: rel.name || rel.tag_name, body: rel.body || '', prerelease: rel.prerelease };
  let gt = existing.get(rel.tag_name), action;

  if (!gt) {
    // Creating a release for a tag Gitea doesn't have yet would tag the default branch instead
    const tag = await request(`${gtRepo}/tags/${rel.tag_name.split('/').map(encodeURIComponent).join('/')}`,
      gtHeaders, 'GET', null, true);
    if (!tag) {
      facts.unsyncedTags++;
      return console.log(`Waiting for mirror sync: ${where}`);
    }
    gt = await request(`${gtRepo}/releases`, gtHeaders, 'POST', { tag_name: rel.tag_name, ...want });
    facts.created++;
    action = 'Created';
  } else if (Object.entries(want).some(([k, v]) => gt[k] !== v)) {
    gt = await request(`${gtRepo}/releases/${gt.id}`, gtHeaders, 'PATCH', want);
    facts.updated++;
    action = 'Updated';
  }

  const have = new Set(gt.assets.map(asset => asset.name));
  let uploaded = 0;
  for (const asset of rel.assets.filter(asset => !have.has(asset.name))) {
    await copyAsset(gh, gtRepo, gt.id, asset);
    uploaded++;
    facts.assetsUploaded++;
  }

  if (action || uploaded) {
    const assets = uploaded ? ` (+${uploaded} asset${uploaded === 1 ? '' : 's'})` : '';
    const line = `${action || 'Added assets to'} ${where}${assets}`;
    facts.changes.push(line);
    console.log(line);
  }
};

(async () => {
  const [gtUser, gtOrgs] = await Promise.all([
    request(`${gitea}/user`, gtHeaders),
    pages(`${gitea}/user/orgs`, gtHeaders, 'limit')
  ]);
  const owners = [gtUser.login, ...gtOrgs.map(org => org.username || org.name)];
  const repos = (await Promise.all(owners.map((owner, i) =>
    pages(i ? `${gitea}/orgs/${enc(owner)}/repos` : `${gitea}/user/repos`, gtHeaders, 'limit')
  ))).flat();
  const ownerKeys = new Set(owners.map(key));

  // Frozen mirrors (sync interval 0, e.g. renamed -goneN ones) never get new tags
  const mirrors = [...new Map(repos.map(repo => [repo.id, repo])).values()]
    .filter(repo => repo.mirror && repo.original_url && !repo.archived && repo.mirror_interval !== '0s')
    .filter(repo => ownerKeys.has(key(repo.owner.login)))
    .map(repo => ({ repo, gh: source(repo) }))
    .filter(mirror => mirror.gh);
  facts.mirrorsChecked = mirrors.length;
  console.log(`Checking releases for ${mirrors.length} GitHub mirror(s)...`);

  for (const mirror of mirrors) {
    const { repo, gh } = mirror;
    let releases, existing;
    try {
      releases = await pages(`${github}/repos/${enc(gh.owner, gh.name)}/releases`, ghHeaders, 'per_page', true);
      releases = (releases || []).filter(rel => !rel.draft).reverse();
      if (!releases.length) continue;
      const gtReleases = await pages(`${gitea}/repos/${enc(repo.owner.login, repo.name)}/releases`, gtHeaders, 'limit');
      existing = new Map(gtReleases.map(rel => [rel.tag_name, rel]));
    } catch (error) {
      facts.failures++;
      console.error(`Failed to list releases for ${repo.owner.login}/${repo.name}: ${error.message}`);
      continue;
    }

    facts.releasesFound += releases.length;
    for (const rel of releases) {
      try {
        await syncRelease(mirror, rel, existing);
      } catch (error) {
        facts.failures++;
        console.error(`Failed to sync ${repo.owner.login}/${repo.name}@${rel.tag_name}: ${error.message}`);
      }
    }
  }

  console.log(`Created ${facts.created}, updated ${facts.updated}, uploaded ${facts.assetsUploaded} asset(s); ${facts.failures} failure(s).`);
  if (facts.unsyncedTags) console.log(`${facts.unsyncedTags} release(s) wait for their tag to reach Gitea.`);
  if (facts.failures) process.exitCode = 1;
})().catch(error => {
  console.error(`Fatal: ${error.message}`);
  facts.fatal = true;
  process.exitCode = 1;
}).finally(() => {
  if (process.env.GITHUB_ACTIONS) writeFileSync('release-facts.json', JSON.stringify(facts));
});
