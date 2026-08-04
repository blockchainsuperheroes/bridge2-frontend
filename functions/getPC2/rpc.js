// Cloudflare Pages Function — POST /stake/rpc
//
// Read-only eth_call proxy to the PCStakeLedger on Pentagon Chain. The browser
// can't read Pentagon Chain directly (no CORS on rpc.pentagon.games), so the
// frontend builds calldata with ethers and POSTs {to, data} here. Locked down:
// eth_call only, and only to the configured ledger address — nothing else.
//
// Env (Pages project settings):
//   LEDGER_ADDRESS — PCStakeLedger address on Pentagon Chain (required to enable)
//   PC_RPC_URL     — optional dedicated RPC; defaults to the public endpoint

// TEST default so the read-proxy works with no dashboard env var; override with
// the LEDGER_ADDRESS env var for the production instance.
const TEST_LEDGER = '0x04c1b7232f5575a3fec4b221667cce585f15f3c3';

export async function onRequestPost({ request, env }) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  const LEDGER = (env.LEDGER_ADDRESS || TEST_LEDGER).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(LEDGER) || LEDGER === '0x0000000000000000000000000000000000000000') {
    return new Response(JSON.stringify({ error: 'ledger not configured' }), { status: 503, headers });
  }
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers }); }
  const to = String(body.to || '').toLowerCase();
  const data = String(body.data || '');
  if (to !== LEDGER) return new Response(JSON.stringify({ error: 'address not allowed' }), { status: 403, headers });
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data) || data.length > 4096) {
    return new Response(JSON.stringify({ error: 'bad calldata' }), { status: 400, headers });
  }
  try {
    const r = await fetch(env.PC_RPC_URL || 'https://rpc.pentagon.games', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    });
    const j = await r.json();
    if (j.error) return new Response(JSON.stringify({ error: j.error.message || 'rpc error' }), { status: 502, headers });
    return new Response(JSON.stringify({ result: j.result }), { headers });
  } catch {
    return new Response(JSON.stringify({ error: 'rpc unavailable' }), { status: 502, headers });
  }
}
