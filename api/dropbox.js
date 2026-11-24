// Streams a public Dropbox file or folder (as .zip) to the browser, same-origin.
// Only Dropbox hosts are allowed so this can't be used as an open proxy.
const ALLOWED = /(^|\.)dropbox\.com$|(^|\.)dropboxusercontent\.com$/;

function fail(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function GET(request) {
  const raw = new URL(request.url).searchParams.get('url') || '';
  let target;
  try { target = new URL(raw); } catch { return fail(400, 'That isn’t a valid link.'); }
  if (target.protocol !== 'https:' || !ALLOWED.test(target.hostname)) {
    return fail(400, 'Only public Dropbox links are supported.');
  }
  // Share pages (www.dropbox.com) need dl=1 to return the file, or a .zip for folders.
  if (/(^|\.)dropbox\.com$/.test(target.hostname)) {
    target.searchParams.delete('raw');
    target.searchParams.set('dl', '1');
  }

  let upstream;
  try {
    upstream = await fetch(target, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (CC Release Promo)' } });
  } catch {
    return fail(502, 'Couldn’t reach Dropbox. Try again in a moment.');
  }
  if (!upstream.ok) {
    if (upstream.status === 404 || upstream.status === 409) return fail(404, 'Dropbox says that link doesn’t exist or has expired.');
    if (upstream.status === 403) return fail(403, 'That link isn’t public. In Dropbox, share it as “Anyone with the link can view”.');
    if (upstream.status === 429 || upstream.status === 460) return fail(429, 'Dropbox is limiting downloads from this link right now. Try again later.');
    return fail(502, `Dropbox returned an error (${upstream.status}).`);
  }
  const type = upstream.headers.get('content-type') || 'application/octet-stream';
  if (type.includes('text/html')) {
    return fail(422, 'That link opened a Dropbox page, not a file. Check it’s shared as “Anyone with the link”. Very large folders may need splitting.');
  }
  const headers = new Headers({ 'content-type': type, 'cache-control': 'no-store' });
  for (const k of ['content-length', 'content-disposition']) {
    const v = upstream.headers.get(k);
    if (v) headers.set(k, v);
  }
  return new Response(upstream.body, { status: 200, headers });
}
