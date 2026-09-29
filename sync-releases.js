const { writeFileSync } = require('node:fs');
const { github, ghHeaders, gtHeaders, enc, request, pages, listMirrors } = require('./gitea-mirrors');
const facts = {
  mirrorsChecked: 0, releasesFound: 0, created: 0, updated: 0, assetsUploaded: 0,
  unsyncedTags: 0, failures: 0, changes: []
};
const transferTimeout = () => AbortSignal.timeout(30 * 60_000);

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

const syncRelease = async ({ gh, gtRepo, name }, rel, existing) => {
  const where = `${name}@${rel.tag_name}`;
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
  const mirrors = await listMirrors();
  facts.mirrorsChecked = mirrors.length;
  console.log(`Checking releases for ${mirrors.length} GitHub mirror(s)...`);

  for (const mirror of mirrors) {
    const { gh, gtRepo, name } = mirror;
    let releases, existing;
    try {
      releases = await pages(`${github}/repos/${enc(gh.owner, gh.name)}/releases`, ghHeaders, 'per_page', true);
      releases = (releases || []).filter(rel => !rel.draft).reverse();
      if (!releases.length) continue;
      const gtReleases = await pages(`${gtRepo}/releases`, gtHeaders, 'limit');
      existing = new Map(gtReleases.map(rel => [rel.tag_name, rel]));
    } catch (error) {
      facts.failures++;
      console.error(`Failed to list releases for ${name}: ${error.message}`);
      continue;
    }

    facts.releasesFound += releases.length;
    for (const rel of releases) {
      try {
        await syncRelease(mirror, rel, existing);
      } catch (error) {
        facts.failures++;
        console.error(`Failed to sync ${name}@${rel.tag_name}: ${error.message}`);
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
