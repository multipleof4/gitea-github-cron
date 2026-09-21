const syncOrgAvatar = async (org, giteaApi, headers) => {
  if (!org.avatar_url) return false;

  const avatar = await fetch(org.avatar_url, { signal: AbortSignal.timeout(30_000) });
  if (!avatar.ok) throw new Error(`GitHub avatar download failed: ${avatar.status}`);

  const image = Buffer.from(await avatar.arrayBuffer());
  if (!image.length) throw new Error('GitHub avatar is empty');

  const upload = await fetch(`${giteaApi}/orgs/${encodeURIComponent(org.login)}/avatar`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ image: image.toString('base64') }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!upload.ok) throw new Error(`Gitea avatar upload failed: ${upload.status} ${await upload.text()}`);
  return true;
};

module.exports = syncOrgAvatar;
