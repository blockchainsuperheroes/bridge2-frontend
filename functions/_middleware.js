// Cloudflare Pages middleware — runs on every request to this project.
//
// One job: the project serves the BRIDGE at "/" and GetPC 2 under "/getPC2/".
// When someone arrives on the getpc.* hostname they want GetPC 2, not the
// bridge, so send the site root there. Every other host and path is untouched.
//
// Host-based routing has to live here because Pages `_redirects` matches on path
// only, and the zone is on external DNS (GoDaddy) so there are no Cloudflare
// zone-level redirect rules available either.

const GETPC_HOSTS = ['getpc.pentagon.games', 'www.getpc.pentagon.games'];

export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const host = (request.headers.get('host') || url.hostname).toLowerCase();

  if (GETPC_HOSTS.includes(host)) {
    // Only rewrite the bare root; deep links (/getPC2/..., /bridge/..., the
    // rpc + policy Functions) must pass through untouched.
    if (url.pathname === '/' || url.pathname === '') {
      const to = new URL('/getPC2/', url);
      to.search = url.search;               // keep ?ref=… etc.
      return Response.redirect(to.toString(), 302);
    }
  }
  return next();
}
