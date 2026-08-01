// Cloudflare Pages Function — GET /bridge/status
//
// The browser can't read Pentagon Chain (no CORS), so this runs server-side on
// Cloudflare's edge (same origin as the site — no CORS needed) and reports
// whether a bridge2 deposit has been released on Pentagon Chain, plus the
// payout tx. Reads are done over JSON-RPC; the public endpoint works for these,
// and PC_RPC_URL (a Pages env var / secret) can override with a dedicated token.
// The RPC URL is never sent to the browser.
//
//   GET /bridge/status?depositId=<n>&srcChainId=<n>&srcVault=<0x..>
//     -> { credited: boolean, claimTx?: string, amount?: string }

const PAYOUT = '0x3eA48540A0cF76225aE6914F9A4D26c4c4f58bf4'; // PCPayout
const SEL_CLAIMIDOF = '0x8ed5c124'; // claimIdOf(uint256,address,uint256)
const SEL_PROCESSED = '0xc1f0808a'; // processed(bytes32)
const TOPIC_CLAIMED = '0x53e1382837b65097f1436df00ad198ee1ef46d20d3209d9d951b2c5560e9e623'; // Claimed(bytes32,uint256,address,uint256)
const LOG_WINDOW = 9000n; // public RPC caps eth_getLogs at 10000 blocks

const num32 = (v) => BigInt(v).toString(16).padStart(64, '0');
const hex32 = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const depositId = url.searchParams.get('depositId');
  const srcChainId = url.searchParams.get('srcChainId') || '1';
  const srcVault = url.searchParams.get('srcVault');
  const headers = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  };

  if (depositId == null || depositId === '' || !/^0x[0-9a-fA-F]{40}$/.test(srcVault || '')) {
    return new Response(JSON.stringify({ error: 'depositId and srcVault required' }), { status: 400, headers });
  }

  const RPC = env.PC_RPC_URL || 'https://rpc.pentagon.games';
  try {
    // claimId via the on-chain view (avoids needing keccak here)
    const data = SEL_CLAIMIDOF + num32(srcChainId) + hex32(srcVault) + num32(depositId);
    const cid = await rpc(RPC, 'eth_call', [{ to: PAYOUT, data }, 'latest']);
    if (!cid || cid === '0x') return new Response(JSON.stringify({ credited: false }), { headers });

    const proc = await rpc(RPC, 'eth_call', [{ to: PAYOUT, data: SEL_PROCESSED + hex32(cid) }, 'latest']);
    const credited = BigInt(proc || '0x0') !== 0n;
    const body = { credited };

    if (credited) {
      // best-effort: the payout tx + amount from the Claimed event (may be
      // outside the 10k-block window for old deposits — that's fine)
      try {
        const head = BigInt(await rpc(RPC, 'eth_blockNumber', []));
        const from = head > LOG_WINDOW ? head - LOG_WINDOW : 0n;
        const logs = await rpc(RPC, 'eth_getLogs', [{
          address: PAYOUT,
          topics: [TOPIC_CLAIMED, cid],
          fromBlock: '0x' + from.toString(16),
          toBlock: 'latest',
        }]);
        if (Array.isArray(logs) && logs.length) {
          const ev = logs[logs.length - 1];
          body.claimTx = ev.transactionHash;
          body.amount = BigInt(ev.data).toString(); // amount is the only non-indexed field
        }
      } catch { /* best-effort */ }
    }

    return new Response(JSON.stringify(body), { headers });
  } catch {
    return new Response(JSON.stringify({ credited: false, error: 'rpc' }), { status: 200, headers });
  }
}
