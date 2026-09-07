/* GetPC 2 — Ops Console.
   Deployed live so the owner can reconnect any time and be told, in plain words,
   where the programme stands and whether anything needs doing.

   SECURITY MODEL: the URL is not the boundary. Every write below is an owner-only
   contract call — a non-owner gets disabled buttons here and a revert on-chain.
   No keys or secrets live in this file. */

const VAULT_ADDR  = '0xe31d31Ecb5Fbee1d142a26E44BEdC94C4DFb3B34'; // Ethereum
const LEDGER_ADDR = '0x04c1B7232f5575A3FEC4b221667CcE585F15F3C3'; // Pentagon Chain 3344
const ETH_HEX = '0x1', PC_HEX = '0xd10';
const PC_RPC = 'https://rpc.pentagon.games';
const PC_EXP = 'https://explorer.pentagon.games';
const ETH_EXP = 'https://etherscan.io';
const LEDGER_PROXY = '/getPC2/rpc';        // same-origin read proxy (PC sends no CORS)
const ETH_RPCS = ['https://eth.llamarpc.com','https://ethereum-rpc.publicnode.com',
                  'https://1rpc.io/eth','https://eth.drpc.org','https://rpc.ankr.com/eth'];
const MAX_RATE = 0.18;                     // worst-case headline rate, for liability maths
const COVER_WARN_DAYS = 90;                // nudge to fund below this much cover

const VAULT_ABI = [
  'function owner() view returns (address)','function pendingOwner() view returns (address)',
  'function acceptOwnership()','function totalStaked() view returns (uint256)',
  'function emergencyUnlock() view returns (bool)','function minTermDays() view returns (uint32)',
  'function maxTermDays() view returns (uint32)','function maxStakePerStaker() view returns (uint256)',
  'function memberRegistry() view returns (address)','function paused() view returns (bool)',
  'function pause()','function unpause()','function upgradesLocked() view returns (bool)',
  'function trancheSchedule() view returns (uint256[] ceilings, uint16[4][] rates, uint256 staked)',
];
const LEDGER_ABI = [
  'function owner() view returns (address)','function pendingOwner() view returns (address)',
  'function acceptOwnership()','function poolBalance() view returns (uint256)',
  'function claimInterval() view returns (uint256)','function paused() view returns (bool)',
  'function pause()','function unpause()','function upgradesLocked() view returns (bool)',
  'function maxMirrorAmount() view returns (uint256)','function maxPayoutPerDay() view returns (uint256)',
  'function attestationWindow() view returns (uint256)','function setGuards(uint256,uint256,uint256)',
  'function payoutRatePerSec() view returns (uint256)','function payoutBudgetCap() view returns (uint256)',
  'function availableBudget() view returns (uint256)','function setBudgetGuard(uint256,uint256)',
  'function keeperSigner() view returns (address)','function verifierSigner() view returns (address)',
];

const $ = (id) => document.getElementById(id);
const log = (m, k = '') => { const e = $('log'); e.innerHTML = m; e.className = k; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
const short = (a) => a ? a.slice(0, 7) + '…' + a.slice(-5) : '–';
const pc = (v, d = 2) => (+ethers.formatEther(v)).toLocaleString(undefined, { maximumFractionDigits: d });
const n = (v) => +ethers.formatEther(v);
let account = null, S = {};   // S = latest snapshot of chain state

/* ---------- resilient reads. Public RPCs rate-limit and time out constantly,
   so every read retries across endpoints and NEVER lets a failure look like a
   zero — a missing value stays undefined and renders as "–". ---------- */
const vIface = new ethers.Interface(VAULT_ABI), lIface = new ethers.Interface(LEDGER_ABI);
async function ethCall(fn, args = []) {
  const data = vIface.encodeFunctionData(fn, args);
  for (const url of ETH_RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: VAULT_ADDR, data }, 'latest'] }),
        signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      if (j.result && j.result !== '0x') {
        const d = vIface.decodeFunctionResult(fn, j.result);
        return d.length === 1 ? d[0] : d;
      }
    } catch { /* try next endpoint */ }
  }
  return undefined;
}
async function pcCall(fn, args = []) {
  const data = lIface.encodeFunctionData(fn, args);
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(LEDGER_PROXY, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: LEDGER_ADDR, data }), signal: AbortSignal.timeout(18000) });
      const j = await r.json();
      if (j.result && j.result !== '0x') {
        const d = lIface.decodeFunctionResult(fn, j.result);
        return d.length === 1 ? d[0] : d;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return undefined;
}

/* ---------- wallet ---------- */
async function connect() {
  if (!window.ethereum) { log('No wallet found. Install MetaMask (a hardware wallet can connect through it).', 'err'); return; }
  try {
    const a = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = a[0];
    $('who').innerHTML = `connected <code>${short(account)}</code>`;
    log('Connected. Checking your permissions…');
    await refresh();
  } catch (e) { log('Connection cancelled.', 'err'); }
}
async function signerOn(chainIdHex, addParams) {
  const cur = await window.ethereum.request({ method: 'eth_chainId' });
  if (cur.toLowerCase() !== chainIdHex.toLowerCase()) {
    try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] }); }
    catch (e) {
      if (e.code === 4902 && addParams) await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [addParams] });
      else throw e;
    }
  }
  return await new ethers.BrowserProvider(window.ethereum).getSigner();
}
const ethSigner = () => signerOn(ETH_HEX);
const pcSigner  = () => signerOn(PC_HEX, { chainId: PC_HEX, chainName: 'Pentagon Chain',
  nativeCurrency: { name: 'PC', symbol: 'PC', decimals: 18 }, rpcUrls: [PC_RPC], blockExplorerUrls: [PC_EXP] });

/* one guarded owner action */
async function act(label, confirmMsg, chain, fn) {
  if (!confirm(`${confirmMsg}\n\nThis sends a transaction from your wallet. Continue?`)) return;
  try {
    log(`${label}: confirm in your wallet…`);
    const signer = chain === 'eth' ? await ethSigner() : await pcSigner();
    // Explicit gas: these are UUPS proxies and EIP-150 forwards only 63/64 of gas
    // into the delegatecall — a tight auto-estimate has reverted a real tx before.
    const tx = await fn(signer, { gasLimit: 250000 });
    const base = chain === 'eth' ? ETH_EXP : PC_EXP;
    log(`${label} sent — <a target="_blank" rel="noopener" href="${base}/tx/${tx.hash}">${tx.hash.slice(0,12)}…</a> confirming…`);
    await tx.wait();
    log(`✅ ${label} confirmed.`, 'ok');
    refresh();
  } catch (e) {
    console.error(e);
    log(`⚠️ ${label} failed: ${esc(e?.shortMessage || e?.reason || e?.message || e)}`, 'err');
  }
}

/* ---------- read everything, then decide what to tell the operator ---------- */
async function refresh() {
  log('Reading chain state…');
  const [vo, vp, staked, emerg, minD, maxD, capW, reg, vPaused, sched] = await Promise.all([
    ethCall('owner'), ethCall('pendingOwner'), ethCall('totalStaked'), ethCall('emergencyUnlock'),
    ethCall('minTermDays'), ethCall('maxTermDays'), ethCall('maxStakePerStaker'),
    ethCall('memberRegistry'), ethCall('paused'), ethCall('trancheSchedule'),
  ]);
  const [lo, lp, pool, ci, lPaused, gm, gd, gw, rps, gcap, avail, ks, vs] = await Promise.all([
    pcCall('owner'), pcCall('pendingOwner'), pcCall('poolBalance'), pcCall('claimInterval'),
    pcCall('paused'), pcCall('maxMirrorAmount'), pcCall('maxPayoutPerDay'), pcCall('attestationWindow'),
    pcCall('payoutRatePerSec'), pcCall('payoutBudgetCap'), pcCall('availableBudget'),
    pcCall('keeperSigner'), pcCall('verifierSigner'),
  ]);
  S = { vo, vp, staked, emerg, minD, maxD, capW, reg, vPaused, sched, lo, lp, pool, ci, lPaused, gm, gd, gw, rps, gcap, avail, ks, vs };

  $('rVault').textContent = VAULT_ADDR; $('rLedger').textContent = LEDGER_ADDR;
  $('ledgerAddr').textContent = LEDGER_ADDR;

  /* --- funding maths --- */
  const stakedN = staked !== undefined ? n(staked) : null;
  const poolN = pool !== undefined ? n(pool) : null;
  const liabYr = stakedN === null ? null : stakedN * MAX_RATE;
  const perDay = liabYr === null ? null : liabYr / 365;
  const cover = (poolN === null || perDay === null) ? null : (perDay > 0 ? poolN / perDay : Infinity);
  $('kPool').textContent   = poolN === null ? '–' : pc(pool) + ' $PC';
  $('kStaked').textContent = stakedN === null ? '–' : pc(staked) + ' $PC';
  $('kLiab').textContent   = liabYr === null ? '–' : liabYr.toFixed(0) + ' $PC';
  $('kCover').textContent  = cover === null ? '–' : (cover === Infinity ? '∞' : Math.floor(cover) + ' days');
  const pctRaw = cover === null ? 0 : (cover === Infinity ? 100 : Math.min(100, cover / (COVER_WARN_DAYS * 2) * 100));
  $('coverBar').firstElementChild.style.width = pctRaw + '%';
  $('coverBar').className = 'bar' + (cover !== null && cover !== Infinity && cover < COVER_WARN_DAYS ? ' low' : '');
  $('coverNote').innerHTML = cover === null ? 'Could not read — retry.'
    : cover === Infinity ? 'Nothing committed yet, so nothing is accruing. Any pool balance is plenty for now.'
    : `At the current commitment level the pool covers <b>${Math.floor(cover)} days</b> of rewards `
      + `(worst case, everyone on the top ${(MAX_RATE*100).toFixed(0)}% rate). Aim to stay above ${COVER_WARN_DAYS} days.`;

  /* --- guards --- */
  const ratePerDay = rps !== undefined ? n(rps) * 86400 : null;
  $('gRate').innerHTML   = ratePerDay === null ? '–' : `<b>${ratePerDay.toFixed(2)} $PC/day</b>`;
  $('gCap').textContent  = gcap === undefined ? '–' : pc(gcap) + ' $PC';
  $('gAvail').textContent= avail === undefined ? '–' : pc(avail) + ' $PC';
  $('gDay').textContent  = gd === undefined ? '–' : (n(gd) === 0 ? 'off' : pc(gd) + ' $PC/day');
  $('gMirror').textContent = gm === undefined ? '–' : pc(gm) + ' $PC';
  // does the guard still comfortably cover the programme?
  let guardMsg = '';
  if (ratePerDay !== null && perDay !== null) {
    const headroom = perDay > 0 ? ratePerDay / perDay : Infinity;
    const bindsAt = ratePerDay * 365 / MAX_RATE;   // committed $PC at which the rate starts to bind
    $('tier0').innerHTML = '<span class="ok">active</span>';
    if (headroom !== Infinity && headroom < 1) {
      guardMsg = `<b>⚠️ The refill rate is now below what the programme legitimately accrues.</b> `
        + `Claims will start to queue. Step up to the next tier below.`;
    } else if (headroom !== Infinity && headroom < 1.5) {
      guardMsg = `<b>Heads up:</b> commitments are approaching what this guard covers `
        + `(binds at about ${bindsAt.toFixed(0)} $PC committed). Plan to step up soon.`;
    } else {
      guardMsg = `Comfortable — this setting covers up to about <b>${bindsAt.toFixed(0)} $PC committed</b> `
        + `before it needs raising. Nothing to do until then.`;
    }
    $('guardVerdict').style.display = 'block';
    $('guardVerdict').innerHTML = guardMsg;
  }

  /* --- rates --- */
  if (sched) {
    const [ceilings, rates, st] = sched;
    let idx = -1;
    for (let i = 0; i < ceilings.length; i++) { if (st < ceilings[i]) { idx = i; break; } }
    const labels = ['3 months','6 months','12 months','24 months'];
    if (idx >= 0) {
      $('rateTbl').innerHTML = '<tr><th>Term</th><th>Rate / yr</th></tr>'
        + labels.map((l, j) => `<tr><td class="k">${l}</td><td><b class="ok">${Number(rates[idx][j]) / 100}%</b></td></tr>`).join('');
      const room = n(ceilings[idx]) - n(st);
      $('rateNote').innerHTML = `Tranche <b>${'ABC'[idx] || idx + 1}</b> is active — `
        + `<b>${room.toLocaleString(undefined,{maximumFractionDigits:0})} $PC</b> of room left before rates step down for new members.`;
    } else {
      $('rateTbl').innerHTML = '<tr><th colspan="2">Programme full — new locks are closed</th></tr>';
      $('rateNote').textContent = 'Committed $PC has reached the final ceiling.';
    }
  }

  /* --- config table --- */
  const cfg = [
    ['emergencyUnlock', emerg === undefined ? null : (emerg ? 'true' : 'false'), 'false', emerg === false],
    ['Term range', (minD === undefined ? null : `${minD} – ${maxD} days`), '90 – 730', Number(minD) === 90 && Number(maxD) === 730],
    ['Per-wallet cap', capW === undefined ? null : pc(capW) + ' $PC', '100 $PC', capW !== undefined && n(capW) === 100],
    ['Claim interval', ci === undefined ? null : (Number(ci) / 86400) + ' days', '7 days', Number(ci) === 604800],
    ['Member gate', reg === undefined ? null : (reg === ethers.ZeroAddress ? 'open to anyone' : short(reg)), 'open (v1)', true],
    ['Vault paused', vPaused === undefined ? null : (vPaused ? 'YES' : 'no'), 'no', vPaused === false],
    ['Ledger paused', lPaused === undefined ? null : (lPaused ? 'YES' : 'no'), 'no', lPaused === false],
    ['Attestation window', gw === undefined ? null : (Number(gw) === 0 ? 'off' : Number(gw)/86400 + ' days'), 'off until keeper ready', true],
    ['Vault owner', short(vo), short(vp) === '–' ? 'you' : 'pending accept', vp === ethers.ZeroAddress],
    ['Ledger owner', short(lo), lp === ethers.ZeroAddress ? 'you' : 'pending accept', lp === ethers.ZeroAddress],
    ['Keeper signer', short(ks), 'KMS (pending)', false],
    ['Verifier signer', short(vs), 'KMS (pending)', false],
  ];
  $('cfgTbl').innerHTML = '<tr><th>Setting</th><th>Current</th><th>Expected</th></tr>'
    + cfg.map(([k, v, e, good]) => `<tr><td class="k">${k}</td>`
      + `<td class="${v === null ? '' : (good ? 'ok' : 'warn')}">${v === null ? '<span class="muted">read failed</span>' : esc(v)}</td>`
      + `<td class="muted">${esc(e)}</td></tr>`).join('');

  /* --- permissions --- */
  const isVOwner = account && vo && vo.toLowerCase() === account.toLowerCase();
  const isLOwner = account && lo && lo.toLowerCase() === account.toLowerCase();
  const isVPend  = account && vp && vp.toLowerCase() === account.toLowerCase();
  const isLPend  = account && lp && lp.toLowerCase() === account.toLowerCase();
  $('acceptRow').style.display = (isVPend || isLPend) ? 'flex' : 'none';
  $('vAccept').disabled = !isVPend; $('lAccept').disabled = !isLPend;
  $('bGuard').disabled = !isLOwner;
  document.querySelectorAll('.bTier').forEach((b) => { b.disabled = !isLOwner; });
  $('vPause').disabled = !isVOwner || vPaused; $('vUnpause').disabled = !isVOwner || !vPaused;
  $('lPause').disabled = !isLOwner || lPaused; $('lUnpause').disabled = !isLOwner || !lPaused;

  renderVerdict({ isVPend, isLPend, isVOwner, isLOwner, cover, poolN, stakedN, perDay, ratePerDay, vPaused, lPaused, gw });
  log('');
}

/* ---------- the headline: what, if anything, needs doing ---------- */
function renderVerdict(c) {
  const todo = [], done = [];
  if (c.isVPend || c.isLPend) {
    todo.push(`<b>Accept ownership</b> — until you do, the deployer key still controls the programme. `
      + `Buttons are below.`);
  } else if (c.isVOwner && c.isLOwner) {
    done.push('You own both contracts. The deployer key has no power.');
  }
  if (c.cover !== null && c.cover !== Infinity && c.cover < COVER_WARN_DAYS) {
    todo.push(`<b>Top up the reward pool</b> — about ${Math.floor(c.cover)} days of cover left. `
      + `Sending ${Math.ceil((COVER_WARN_DAYS * 2 - c.cover) * (c.perDay || 0)) || 250} $PC restores a comfortable buffer.`);
  } else if (c.cover !== null) {
    done.push(c.cover === Infinity
      ? 'Reward pool is fine — nothing committed yet, so nothing is accruing.'
      : `Reward pool has ${Math.floor(c.cover)} days of cover. No action needed.`);
  }
  if (c.ratePerDay !== null && c.perDay !== null && c.perDay > 0 && c.ratePerDay / c.perDay < 1.5) {
    todo.push(`<b>Step up the payout guard</b> — commitments have grown into the current setting. `
      + `Use the tier table below.`);
  } else if (c.ratePerDay !== null) {
    done.push('Payout guard has plenty of headroom for the current commitment level.');
  }
  if (c.vPaused) todo.push('<b>Vault is paused</b> — no new locks can be created.');
  if (c.lPaused) todo.push('<b>Ledger is paused</b> — members cannot claim.');
  if (!account) todo.unshift('<b>Connect your wallet</b> to enable owner actions (read-only until you do).');

  const el = $('verdict');
  if (todo.length === 0) {
    el.className = 'ok';
    $('vtitle').textContent = '✅ All good — nothing needs doing';
    $('vsub').textContent = 'Reconnect any time; this page will tell you if that changes.';
  } else {
    const urgent = todo.some((t) => /Top up|paused|Step up/.test(t));
    el.className = urgent ? 'act' : 'warn';
    $('vtitle').textContent = urgent ? `⚠️ ${todo.length} thing${todo.length > 1 ? 's need' : ' needs'} your attention`
                                     : `${todo.length} thing${todo.length > 1 ? 's' : ''} to do`;
    $('vsub').textContent = 'Everything else is running normally.';
  }
  $('vlist').innerHTML = todo.map((t) => `<li>${t}</li>`).join('')
    + done.map((t) => `<li class="done">${t}</li>`).join('');
}

/* ---------- member activity from chain logs ---------- */
const TOPIC = {
  staked:    '0x2b271631881ee90c9a86f08832aedf656c5470723dc55a1ebe3146a4ba7fbf38',
  withdrawn: '0x92ccf450a286a957af52509bc1c9939d1a6a481783e142e41e2499f0bb66ebc6',
  claimed:   '0x3f08a117a70ae744d9df15a54da36bd32813cc15aa67ec12a7ec9e7f0985d3c5',
  funded:    '0x32173d8e51cec3a6fe484b7a1c3febe760cdf96e03d4cca36a43563a4333e838',
};
async function rawRpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
async function loadHistory() {
  $('histNote').textContent = 'reading logs…';
  const rows = [];
  // Ethereum side — stakes and withdrawals
  for (const url of ETH_RPCS) {
    try {
      const head = parseInt(await rawRpc(url, 'eth_blockNumber', []), 16);
      const from = '0x' + Math.max(0, head - 45000).toString(16);       // ~1 week of blocks
      const logs = await rawRpc(url, 'eth_getLogs', [{ address: VAULT_ADDR,
        topics: [[TOPIC.staked, TOPIC.withdrawn]], fromBlock: from, toBlock: 'latest' }]);
      for (const l of logs) {
        const who = '0x' + l.topics[1].slice(26);
        const isStake = l.topics[0] === TOPIC.staked;
        const amt = BigInt('0x' + l.data.slice(2, 66));
        rows.push({ chain: 'eth', blk: parseInt(l.blockNumber, 16), tx: l.transactionHash,
          kind: isStake ? '🔒 staked' : '↩️ withdrew', who, amt });
      }
      break;
    } catch { /* next endpoint */ }
  }
  // Pentagon Chain — claims and pool top-ups (10k-block getLogs limit, ~28h)
  try {
    const head = parseInt(await rawRpc(PC_RPC, 'eth_blockNumber', []), 16);
    const from = '0x' + Math.max(0, head - 8500).toString(16);           // ~24h
    const logs = await rawRpc(PC_RPC, 'eth_getLogs', [{ address: LEDGER_ADDR,
      topics: [[TOPIC.claimed, TOPIC.funded]], fromBlock: from, toBlock: 'latest' }]);
    for (const l of logs) {
      const isClaim = l.topics[0] === TOPIC.claimed;
      rows.push({ chain: 'pc', blk: parseInt(l.blockNumber, 16), tx: l.transactionHash,
        kind: isClaim ? '💰 claimed' : '➕ pool funded',
        who: '0x' + (l.topics[isClaim ? 2 : 1] || '').slice(26),
        amt: BigInt('0x' + l.data.slice(2, 66)) });
    }
  } catch { /* PC RPC is flaky; show what we have */ }

  rows.sort((a, b) => b.blk - a.blk);
  $('histTbl').innerHTML = rows.length
    ? '<tr><th>Event</th><th>Wallet</th><th>Amount</th><th>Tx</th></tr>' + rows.map((r) =>
        `<tr><td>${r.kind}</td><td class="k"><code>${short(r.who)}</code></td>`
        + `<td><b>${pc(r.amt, 6)}</b> $PC</td>`
        + `<td><a target="_blank" rel="noopener" href="${(r.chain === 'eth' ? ETH_EXP : PC_EXP)}/tx/${r.tx}">view</a></td></tr>`).join('')
    : '<tr><td class="muted">No activity in the window.</td></tr>';
  $('histNote').innerHTML = `${rows.length} event(s) · Ethereum ~last week, Pentagon Chain ~last 24h `
    + `<span class="muted">(public RPCs cap how far back logs can be read)</span>`;
}

/* ---------- wiring ---------- */
window.addEventListener('DOMContentLoaded', () => {
  $('connect').onclick = connect;
  $('refresh').onclick = refresh;
  $('loadHist').onclick = loadHistory;
  $('copyAddr').onclick = () => { navigator.clipboard?.writeText(LEDGER_ADDR); log('Ledger address copied.', 'ok'); };

  $('vAccept').onclick = () => act('Accept vault ownership',
    'Accept ownership of the GetPC 2 VAULT on Ethereum.\nAfter this, the deployer key can no longer change it.', 'eth',
    (s, g) => new ethers.Contract(VAULT_ADDR, VAULT_ABI, s).acceptOwnership(g));
  $('lAccept').onclick = () => act('Accept ledger ownership',
    'Accept ownership of the GetPC 2 LEDGER on Pentagon Chain.\nAfter this, the deployer key can no longer change it.', 'pc',
    (s, g) => new ethers.Contract(LEDGER_ADDR, LEDGER_ABI, s).acceptOwnership(g));

  $('bFund').onclick = async () => {
    const amt = $('fundAmt').value.trim();
    if (!amt || isNaN(+amt) || +amt <= 0) { log('Enter an amount in $PC.', 'err'); return; }
    if (!confirm(`Send ${amt} $PC to the reward pool on Pentagon Chain?\n\n${LEDGER_ADDR}`)) return;
    try {
      log('Confirm the transfer in your wallet…');
      const s = await pcSigner();
      const tx = await s.sendTransaction({ to: LEDGER_ADDR, value: ethers.parseEther(amt) });
      log(`Sent — <a target="_blank" rel="noopener" href="${PC_EXP}/tx/${tx.hash}">${tx.hash.slice(0,12)}…</a> confirming…`);
      await tx.wait(); log('✅ Pool funded.', 'ok'); refresh();
    } catch (e) { log(`⚠️ Funding failed: ${esc(e?.shortMessage || e?.message || e)}`, 'err'); }
  };

  const setGuard = (ratePerDay, cap) => act('Set payout guard',
    `Refill rate: ${ratePerDay} $PC/day\nBurst cap: ${cap} $PC\n\n`
    + `The cap must stay above the largest legitimate single claim (36 $PC for a maxed 2-year position).`,
    'pc', (s, g) => new ethers.Contract(LEDGER_ADDR, LEDGER_ABI, s)
      .setBudgetGuard(ethers.parseEther(String(ratePerDay)) / 86400n, ethers.parseEther(String(cap)), g));
  document.querySelectorAll('.bTier').forEach((b) => {
    b.onclick = () => setGuard(b.dataset.r, b.dataset.c);
  });
  $('bGuard').onclick = () => {
    const r = $('cRate').value.trim(), c = $('cCap').value.trim();
    if (!r || !c || isNaN(+r) || isNaN(+c)) { log('Enter both a rate and a cap.', 'err'); return; }
    if (+c < 36) { if (!confirm(`A cap below 36 $PC can permanently block a member who held a full 100 $PC position for two years.\n\nSet it anyway?`)) return; }
    setGuard(r, c);
  };

  $('vPause').onclick   = () => act('Pause vault', 'Stop NEW locks being created. Withdrawals stay open.', 'eth', (s,g)=>new ethers.Contract(VAULT_ADDR,VAULT_ABI,s).pause(g));
  $('vUnpause').onclick = () => act('Resume vault', 'Allow new locks again.', 'eth', (s,g)=>new ethers.Contract(VAULT_ADDR,VAULT_ABI,s).unpause(g));
  $('lPause').onclick   = () => act('Pause ledger', 'Stop claims. Principal is unaffected and stays withdrawable.', 'pc', (s,g)=>new ethers.Contract(LEDGER_ADDR,LEDGER_ABI,s).pause(g));
  $('lUnpause').onclick = () => act('Resume ledger', 'Allow claims again.', 'pc', (s,g)=>new ethers.Contract(LEDGER_ADDR,LEDGER_ABI,s).unpause(g));

  if (window.ethereum) {
    window.ethereum.on?.('accountsChanged', (a) => { account = a[0] || null;
      $('who').innerHTML = account ? `connected <code>${short(account)}</code>` : ''; refresh(); });
  }
  refresh();   // read-only view before connecting
});
