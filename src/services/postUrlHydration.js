function parseGsUrl(gsUrl) {
  if (typeof gsUrl !== 'string') return null;
  if (!gsUrl.startsWith('gs://')) return null;
  const withoutScheme = gsUrl.slice('gs://'.length);
  const firstSlash = withoutScheme.indexOf('/');
  if (firstSlash === -1) return null;
  const bucket = withoutScheme.slice(0, firstSlash);
  const objectPath = withoutScheme.slice(firstSlash + 1);
  if (!bucket || !objectPath) return null;
  return { bucket, objectPath };
}

async function toSignedUrlMaybe(storage, url, ttlMs) {
  const parsed = parseGsUrl(url);
  if (!parsed) return url;

  const [signedUrl] = await storage
    .bucket(parsed.bucket)
    .file(parsed.objectPath)
    .getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + ttlMs
    });

  return signedUrl;
}

async function hydratePostUrls(storage, postData, ttlMs) {
  const out = { ...postData };

  if (Array.isArray(out.media)) {
    out.media = await Promise.all(
      out.media.map(async (m) => {
        if (!m || typeof m !== 'object') return m;

        const signedFromGcsPath = await toSignedUrlMaybe(storage, m.gcsPath, ttlMs);

        const next = { ...m };
        if (signedFromGcsPath && signedFromGcsPath !== m.gcsPath) {
          next.signedUrl = signedFromGcsPath;
        }

        return next;
      })
    );
  }

  
  if (out.thumbnailUrl && typeof out.thumbnailUrl === 'object') {
    const candidate = out.thumbnailUrl.gcsPath;
    const signedThumb = await toSignedUrlMaybe(storage, candidate, ttlMs);
    if (signedThumb !== candidate) {
      out.thumbnailUrl.signedUrl = signedThumb;
    }
  }

  return out;
}

module.exports = {
  hydratePostUrls
};
