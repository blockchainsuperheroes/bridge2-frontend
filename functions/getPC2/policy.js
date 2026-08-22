// Cloudflare Pages Function — GET /getPC2/policy?staker=0x..&posId=N
//
// OFF-CHAIN CLAIM POLICY CHECK.
//
// This is a POLICY / UX layer, NOT a security control. claim() is permissionless,
// so anyone can call the contract directly and bypass this entirely. The on-chain
// accruing budget remains the real enforcement. What this adds is the one check
// the contract physically CANNOT do: Pentagon Chain cannot read Ethereum, but this
// worker can — so it verifies the mirrored position is actually backed by a live
// stake in the Ethereum vault, and declines early with a readable reason instead
// of letting someone hit an opaque revert.
//
// Failure policy:
//   fail OPEN  on infrastructure errors (a dead RPC must never block honest
//              claims — the chain still guards the funds)
//   fail CLOSED on a definite mismatch or a breached volume limit
//
// Env (all optional): ETH_RPC_URL, PC_RPC_URL, LEDGER_ADDRESS, VAULT_ADDRESS,
//                     POLICY_DAILY_PC, POLICY_WALLET_DAILY_PC

const D = {
  ledger: '0x04c1b7232f5575a3fec4b221667cce585f15f3c3',
  vault:  '0xe31d31ecb5fbee1d142a26e44bedc94c4dfb3b34',
  ethRpc: 'https://eth.drpc.org',
  pcRpc:  'https://rpc.pentagon.games',
  dailyPC: 300,       // program-wide 24h payout ceiling (policy — tighter than chain)
  walletDailyPC: 40,  // per-wallet 24h ceiling — the contract has no per-wallet limit
  blocksPerDay: 8500, // Pentagon Chain ~10.2s blocks; one getLogs call covers 24h
};
const SEL = {
  positionsOf: '0xf867d46b', // positionsOf(address)
  positions:   '0x514ea4bf', // positions(bytes32)
  stakeIdOf:   '0x8543c052', // stakeIdOf(uint256,address,address,uint256)
  available:   '0xc7674fa8', // availableBudget()
  pool:        '0x96365d44', // poolBalance()
};
const TOPIC_CLAIMED = '0x3f08a117a70ae744d9df15a54da36bd32813cc15aa67ec12a7ec9e7f0985d3c5';

const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const words = (d) => { const h = (d || '').replace(/^0x/, ''); const o = []; for (let i = 0; i + 64 <= h.length; i += 64) o.push(h.slice(i, i + 64)); return o; };
const W = (w) => BigInt('0x' + w);
const J = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: {
  'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });

async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const staker = (u.searchParams.get('staker') || '').toLowerCase();
  const posId = u.searchParams.get('posId');
  if (!/^0x[0-9a-f]{40}$/.test(staker) || posId === null || posId === '' || !/^\d+$/.test(posId)) {
    return J({ error: 'staker (0x…40) and posId (uint) required' }, 400);
  }
  const LEDGER = (env.LEDGER_ADDRESS || D.ledger).toLowerCase();
  const VAULT  = (env.VAULT_ADDRESS  || D.vault).toLowerCase();
  const ETH = env.ETH_RPC_URL || D.ethRpc;
  const PC  = env.PC_RPC_URL  || D.pcRpc;
  const dailyCap  = BigInt(env.POLICY_DAILY_PC        || D.dailyPC)       * 10n ** 18n;
  const walletCap = BigInt(env.POLICY_WALLET_DAILY_PC || D.walletDailyPC) * 10n ** 18n;

  const out = { ok: true, reasons: [], checks: {},
    limits: { programDaily24h: dailyCap.toString(), walletDaily24h: walletCap.toString() } };

  // ---- 1. THE check the contract cannot do: is a real Ethereum stake behind this? ----
  let ethAmount = null;
  try {
    const res = await rpc(ETH, 'eth_call', [{ to: VAULT, data: SEL.positionsOf + pad(staker) }, 'latest']);
    const w = words(res);
    const len = Number(W(w[1]));           // [0]=offset, [1]=length, then 6 words per struct
    const i = Number(posId);
    if (i >= len) {
      out.ok = false;
      out.reasons.push('No matching stake on Ethereum for this position.');
      out.checks.ethStake = 'MISSING';
    } else {
      const b = 2 + i * 6;
      ethAmount = W(w[b]);                 // amount
      out.checks.ethStake = {
        amount: ethAmount.toString(),
        termDays: Number(W(w[b + 3])),
        rateBps: Number(W(w[b + 4])),
        withdrawn: W(w[b + 5]) !== 0n,
      };
    }
  } catch (e) {
    out.checks.ethStake = 'UNVERIFIED (' + (e.message || 'rpc') + ')'; // fail open
  }

  // ---- 2. does the mirrored ledger position agree with Ethereum? ----
  try {
    const idHex = await rpc(PC, 'eth_call', [{ to: LEDGER,
      data: SEL.stakeIdOf + pad(1) + pad(VAULT) + pad(staker) + pad(posId) }, 'latest']);
    const id = '0x' + words(idHex)[0];
    const pRes = await rpc(PC, 'eth_call', [{ to: LEDGER, data: SEL.positions + id.slice(2) }, 'latest']);
    const p = words(pRes);
    const mirrored = W(p[1]);              // amount
    const open = W(p[6]) !== 0n;
    out.checks.mirrored = { stakeId: id, amount: mirrored.toString(), open };
    if (!open) { out.ok = false; out.reasons.push('Rewards position is not open on Pentagon Chain.'); }
    if (ethAmount !== null && mirrored !== ethAmount) {
      out.ok = false;
      out.reasons.push(`Mirrored amount (${mirrored}) does not match the Ethereum stake (${ethAmount}).`);
      out.checks.amountMatch = false;
    } else if (ethAmount !== null) out.checks.amountMatch = true;
  } catch (e) {
    out.checks.mirrored = 'UNVERIFIED (' + (e.message || 'rpc') + ')'; // fail open
  }

  // ---- 3. volume limits, derived purely from on-chain RewardClaimed events ----
  try {
    const head = Number(await rpc(PC, 'eth_blockNumber', []));
    const from = Math.max(0, head - D.blocksPerDay);
    const logs = await rpc(PC, 'eth_getLogs', [{ address: LEDGER, topics: [TOPIC_CLAIMED],
      fromBlock: '0x' + from.toString(16), toBlock: 'latest' }]);
    let program = 0n, wallet = 0n;
    for (const l of (logs || [])) {
      const amt = W(words(l.data)[0]);                   // amount is the first non-indexed field
      program += amt;
      const who = '0x' + (l.topics[2] || '').slice(26);  // indexed staker
      if (who.toLowerCase() === staker) wallet += amt;
    }
    out.checks.claimed24h = { program: program.toString(), wallet: wallet.toString(), events: (logs || []).length };
    if (program >= dailyCap) { out.ok = false; out.reasons.push('Program-wide 24h payout limit reached — please try again later.'); }
    if (wallet  >= walletCap) { out.ok = false; out.reasons.push('You have reached the 24h claim limit for this wallet.'); }
  } catch (e) {
    out.checks.claimed24h = 'UNVERIFIED (' + (e.message || 'rpc') + ')'; // fail open
  }

  // ---- 4. informational: on-chain budget + pool (the real enforcement) ----
  try {
    out.checks.onchain = {
      availableBudget: W(words(await rpc(PC, 'eth_call', [{ to: LEDGER, data: SEL.available }, 'latest']))[0]).toString(),
      pool: W(words(await rpc(PC, 'eth_call', [{ to: LEDGER, data: SEL.pool }, 'latest']))[0]).toString(),
    };
  } catch { /* informational only */ }

  if (out.ok) out.reasons.push('OK');
  return J(out);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' } });
}
