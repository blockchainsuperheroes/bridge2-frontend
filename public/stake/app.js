/* Pentagon Chain — Stake $PC (simplified, bridge-style UX).
   Patterns inherited from bridge2: scroll-to-enable terms gate; one manual,
   on-chain-verified step per transaction (never trust tx.wait — poll state);
   debug error codes; device-local activity history. */
const CFG = window.PCSTAKE_CONFIG;
const AGREED_KEY = 'pcstake_agreed_v1';
const HIST_KEY = 'pcstake_history_v1';
const GUIDE_KEY = 'pcstake_seen_guide_v1'; // first visit lands on the full program guide once

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const VAULT = [
  'function stake(uint256 amount, uint32 termDays) returns (uint256)',
  'function withdraw(uint256 positionId)',
  'function positionsOf(address) view returns (tuple(uint256 amount,uint64 start,uint64 lockEnd,uint32 termDays,uint16 rewardRateBps,bool withdrawn)[])',
  'function rateFor(uint32 termDays) view returns (uint16)',
  'function trancheSchedule() view returns (uint256[] ceilings, uint16[4][] rates, uint256 staked)',
  'function stakedByStaker(address) view returns (uint256)',
  'function maxStakePerStaker() view returns (uint256)',
];
const LEDGER = [
  'function pending(bytes32) view returns (uint256)',
  'function nextClaimAt(bytes32) view returns (uint256)',
  'function totalClaimed(bytes32) view returns (uint256)',
  'function claim(bytes32)',
  'function positions(bytes32) view returns (address staker,uint256 amount,uint64 start,uint64 lockEnd,uint16 rewardRateBps,uint256 lastClaim,bool open)',
];

const $ = (id) => document.getElementById(id);
const status = (m, k = '') => { const e = $('status'); e.textContent = m; e.className = k; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const spin = (t) => `<span class="spin"></span>${t}`;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtPC = (v) => (+ethers.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 });
// PG Points accrue slowly (1 $PC @ 14% ≈ 0.00038/day), so 4 decimals renders "0".
// Use adaptive precision so small-but-real balances are always visible.
function fmtPoints(v) {
  const n = +ethers.formatUnits(v, 18);
  if (n === 0) return '0';
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (n >= 0.0001) return n.toFixed(6);
  return n.toFixed(10).replace(/0+$/, ''); // tiny but non-zero — never show a bare "0"
}
const fmtDur = (s) => {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${Math.ceil(s / 86400)} d`;
};
const shortA = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const notDeployed = () => CFG.stakeVaultAddress === '0x0000000000000000000000000000000000000000';

let provider, signer, account, vault, pcToken;
// Read-side contracts pinned to an ETH RPC — immune to the wallet switching to
// Pentagon Chain mid-claim (that switch used to break "My locks").
let ethRead, vaultRead, pcTokenRead;
function initReadProviders() {
  ethRead = new ethers.JsonRpcProvider(CFG.ethRpcUrl || 'https://ethereum-rpc.publicnode.com', parseInt(CFG.ethChainIdHex, 16));
  pcTokenRead = new ethers.Contract(CFG.pcTokenAddress, ERC20, ethRead);
  vaultRead = notDeployed() ? null : new ethers.Contract(CFG.stakeVaultAddress, VAULT, ethRead);
}
const ledgerIface = new ethers.Interface(LEDGER);

/* ---------------- terms gate (scroll-to-enable, like the bridge) ---------------- */
function checkTosScroll() {
  const box = $('tosbox'); if (!box) return;
  const canScroll = box.scrollHeight > box.clientHeight + 8;
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  if (atEnd || !canScroll) {
    $('agree').disabled = false;
    const h = $('scrollhint');
    if (h) { h.textContent = '✓ Thanks for reading — you can continue.'; h.classList.add('done'); }
  }
}
function showGate(force) {
  if (!force && localStorage.getItem(AGREED_KEY) === '1') { enterApp(); return; }
  $('gate').style.display = 'flex'; $('app').style.display = 'none';
  const box = $('tosbox'); if (box) box.scrollTop = 0;
  $('agree').disabled = true;
  const h = $('scrollhint'); if (h) { h.textContent = '▼ Scroll through the terms above to enable the button.'; h.classList.remove('done'); }
  setTimeout(checkTosScroll, 60);
}
function enterApp() { $('gate').style.display = 'none'; $('app').style.display = 'block'; }
function agree() {
  if ($('agree').disabled) return;
  if ($('dontshow').checked) localStorage.setItem(AGREED_KEY, '1'); else localStorage.removeItem(AGREED_KEY);
  enterApp();
}

/* ---------------- device-local activity history ---------------- */
function loadHist() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; } }
function addHist(entry) {
  try { const a = loadHist(); a.unshift({ t: Date.now(), ...entry }); if (a.length > 200) a.length = 200; localStorage.setItem(HIST_KEY, JSON.stringify(a)); } catch {}
  renderHist();
}
function renderHist() {
  const a = loadHist();
  $('histCard').style.display = a.length ? 'block' : 'none';
  if (!a.length) return;
  const icon = { stake: '🔒', claim: '💰', withdraw: '↩️' };
  $('histList').innerHTML = a.map((e) => {
    let when = ''; try { when = new Date(e.t).toLocaleString(); } catch {}
    const tx = e.tx ? ` · <a target="_blank" rel="noopener" href="${e.pcTx ? CFG.pcExplorerBase : CFG.explorerBase}/tx/${e.tx}${e.pcTx ? '?tab=internal_txns' : ''}">tx</a>` : '';
    return `<div class="hitem">${icon[e.type] || '·'} <b>${esc(e.text)}</b> — ${esc(when)}${tx}</div>`;
  }).join('');
}
function clearHist() {
  if (!confirm('Clear the activity list on this device? Your on-chain locks are not affected.')) return;
  localStorage.removeItem(HIST_KEY); renderHist();
}

/* ---------------- ledger reads via same-origin proxy (PC chain has no CORS) ---------------- */
async function ledgerRead(fn, args) {
  const data = ledgerIface.encodeFunctionData(fn, args);
  const r = await fetch(CFG.ledgerRpcProxy, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: CFG.ledgerAddress, data }),
  });
  const j = await r.json();
  if (!j.result) throw new Error(j.error || 'ledger read failed');
  return ledgerIface.decodeFunctionResult(fn, j.result);
}
const stakeIdOf = (staker, posId) => ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'address', 'uint256'],
    [BigInt(parseInt(CFG.ethChainIdHex, 16)), CFG.stakeVaultAddress, staker, BigInt(posId)],
  ));

/* ---------------- tranche strip + rate chips ---------------- */
function renderSchedule(ceilings, rates, staked) {
  let idx = ceilings.length, open = false;
  for (let i = 0; i < ceilings.length; i++) if (staked < ceilings[i]) { idx = i; open = true; break; }
  const names = ['A — Founder rates', 'B', 'C', 'D'];
  if (open) {
    const floor = idx === 0 ? 0n : ceilings[idx - 1];
    const size = ceilings[idx] - floor, used = staked - floor;
    $('trTitle').textContent = `🏆 Tranche ${names[idx]}`;
    // "lockable capacity", NOT reward pool — wording must not be confusable
    $('trRemain').textContent = `you can still lock ${fmtPC(size - used)} $PC at these rates`;
    $('trBar').style.width = Math.min(100, Number(used * 10000n / size) / 100) + '%';
  } else {
    $('trTitle').textContent = '⛔ Program full';
    $('trRemain').textContent = 'new locks are closed';
    $('trBar').style.width = '100%';
  }
  const chips = $('rateChips');
  chips.innerHTML = '';
  if (open) CFG.terms.forEach((t, ti) => {
    const pct = Number(rates[idx][ti]) / 100;
    const c = document.createElement('span');
    c.className = 'chip';
    c.innerHTML = `${t.label} <b>${pct.toFixed(pct % 1 ? 1 : 0)}%</b>`;
    chips.appendChild(c);
  });
  // preview of FUTURE tranches — what rates step down to as the program fills
  const nx = $('trNext');
  if (nx) {
    if (!open) { nx.textContent = 'The program has reached its final capacity.'; }
    else {
      const fmtRow = (ri) => CFG.terms.map((t, ti) => { const p = Number(rates[ri][ti]) / 100; return `${t.label.replace(' months', 'mo').replace(' month', 'mo')} ${p.toFixed(p % 1 ? 1 : 0)}%`; }).join(' · ');
      const lines = [];
      for (let ri = idx + 1; ri < rates.length; ri++) {
        const capTxt = `after ${fmtPC(ceilings[ri - 1])} $PC locked`;
        lines.push(`<b style="color:#8b9cc0">Next — Tranche ${names[ri].slice(0, 1)}</b> (${capTxt}): ${fmtRow(ri)}`);
      }
      lines.push(`Program closes at ${fmtPC(ceilings[ceilings.length - 1])} $PC locked. Locked-in rates never change.`);
      nx.innerHTML = lines.join('<br>');
    }
  }
  return { open, idx, rates };
}
async function refreshTranche() {
  if (vaultRead) {
    try {
      const [ceil, rates, staked] = await vaultRead.trancheSchedule();
      return renderSchedule([...ceil], rates.map((r) => [...r].map(Number)), staked);
    } catch {}
  }
  const ceil = CFG.fallbackSchedule.ceilings.map((c) => ethers.parseUnits(c, 18));
  const rates = CFG.fallbackSchedule.rates.map((r) => r.map((x) => x * 100));
  return renderSchedule(ceil, rates, 0n);
}
async function refreshTermRates() {
  const sel = $('term'); sel.innerHTML = '';
  for (const t of CFG.terms) {
    let bps = null;
    if (vaultRead) {
      try { bps = Number(await vaultRead.rateFor(t.days)); } catch {}
    }
    if (bps == null) { // fallback display rate from config (active tranche assumed A pre-launch)
      const ti = CFG.terms.indexOf(t);
      bps = CFG.fallbackSchedule.rates[0][ti] * 100;
    }
    const o = document.createElement('option');
    o.value = t.days; o.dataset.bps = bps;
    const pct = bps / 100;
    o.textContent = `${t.label} — ${pct.toFixed(pct % 1 ? 1 : 0)}% loyalty rate`;
    sel.appendChild(o);
  }
  sel.selectedIndex = 2; // default 12 months
  quote();
}
function quote() {
  const q = $('quote');
  const amt = parseFloat($('amount').value) || 0;
  const o = $('term').selectedOptions[0];
  const bps = o ? Number(o.dataset.bps || 0) : 0;
  if (!amt || !bps) { q.style.display = 'none'; return; }
  const t = CFG.terms.find((x) => x.days === Number(o.value));
  const total = amt * bps / 10000 * (t.days / 365), weekly = amt * bps / 10000 / 52;
  const unlock = new Date(Date.now() + t.days * 86400000).toLocaleDateString();
  q.style.display = 'block';
  q.innerHTML = `≈ <b>${weekly.toFixed(4)} $PC points/week</b> → <b>${total.toFixed(2)} points</b> over ${t.label} · your ${amt} $PC unlocks ${unlock}. <span style="color:#7fae95">(Points live on Pentagon Chain — no cash value, not withdrawable.)</span>`;
}

/* ---------------- wallet ---------------- */
async function connect() {
  if (!window.ethereum) return status('No wallet found. Install MetaMask.', 'err');
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  const net = await provider.getNetwork();
  if ('0x' + net.chainId.toString(16) !== CFG.ethChainIdHex) {
    try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CFG.ethChainIdHex }] }); provider = new ethers.BrowserProvider(window.ethereum); }
    catch { return status(`Switch your wallet to ${CFG.ethChainName}.`, 'err'); }
  }
  signer = await provider.getSigner();
  account = await signer.getAddress();
  $('connect').textContent = shortA(account);
  initReadProviders();
  pcToken = new ethers.Contract(CFG.pcTokenAddress, ERC20, signer);
  vault = notDeployed() ? null : new ethers.Contract(CFG.stakeVaultAddress, VAULT, signer);
  $('form').style.display = 'block';
  $('locksCard').style.display = 'block';
  if (notDeployed()) { $('submit').disabled = true; status('Preview build — staking opens at launch.'); }
  await Promise.all([refreshBalances(), refreshTranche(), refreshTermRates(), refreshLocks()]);
}
async function refreshBalances() {
  if (!account) return;
  try { $('balance').textContent = fmtPC(await pcTokenRead.balanceOf(account)) + ' $PC'; } catch {}
  if (vaultRead) {
    try {
      const [mine, cap] = await Promise.all([vaultRead.stakedByStaker(account), vaultRead.maxStakePerStaker()]);
      $('committed').textContent = `${fmtPC(mine)} / ${fmtPC(cap)} $PC`;
      $('maxCap').textContent = fmtPC(cap);
    } catch {}
  }
}

/* ---------------- guided, on-chain-verified stepper (bridge pattern) ---------------- */
let flow = { steps: [], i: 0, ctx: {} };
function resetFlow() {
  clearInterval(window._track); window._track = null;
  flow = { steps: [], i: 0, ctx: {} };
  $('steps').style.display = 'none';
  $('stepsHdr').innerHTML = ''; $('stepList').innerHTML = ''; $('stepAct').innerHTML = '';
  $('result').innerHTML = '';
  $('submit').style.display = ''; $('submit').disabled = notDeployed();
  status('');
}
function renderSteps() {
  const n = flow.steps.length;
  $('stepsHdr').innerHTML = `You'll sign up to <b>${n}</b> wallet prompt${n > 1 ? 's' : ''}, one at a time. Each is checked on-chain before the next appears.`;
  $('stepList').innerHTML = flow.steps.map((s, i) => {
    const st = s.state || 'pending';
    const dot = st === 'done' ? '✓' : st === 'fail' ? '✗' : (i + 1);
    return `<div class="step ${st}"><span class="dot">${dot}</span><span>${esc(s.label)}${s.sub ? `<span class="sub">${esc(s.sub)}</span>` : ''}</span></div>`;
  }).join('');
}
const setHint = (html) => { const h = $('stepHint'); if (h) h.innerHTML = html; };
async function prepareStep(i) {
  const s = flow.steps[i];
  if (s.precheck) { try { if (await s.precheck()) { s.state = 'done'; renderSteps(); flow.i = i + 1; return flow.i < flow.steps.length ? prepareStep(flow.i) : finalize(); } } catch {} }
  s.state = 'active'; renderSteps();
  const total = flow.steps.length;
  $('stepAct').innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'go'; btn.type = 'button';
  btn.textContent = `Step ${i + 1} of ${total} — ${s.act}`;
  btn.onclick = () => runStep(i);
  const hint = document.createElement('div');
  hint.className = 'hint'; hint.id = 'stepHint';
  hint.innerHTML = `Click to open your wallet and confirm <b>step ${i + 1}</b>. ${total - i - 1 > 0 ? `${total - i - 1} step${total - i - 1 > 1 ? 's' : ''} left after this.` : 'This is the last step.'}`;
  $('stepAct').append(btn, hint);
}
async function runStep(i) {
  const s = flow.steps[i];
  const b = $('stepAct').querySelector('.go'); if (b) b.disabled = true;
  s.state = 'sent'; renderSteps(); setHint(spin('Confirm the transaction in your wallet…'));
  let tx;
  try { tx = await s.run(); }
  catch (err) { s.state = 'fail'; renderSteps(); stepFail(i, err, { retry: true }); return; }
  if (tx && tx.hash) s.hash = tx.hash;
  setHint(spin('Submitted — confirming on-chain…'));
  await verifyStep(i);
}
async function verifyStep(i) {
  const s = flow.steps[i];
  s.state = 'verifying'; renderSteps(); setHint(spin('Confirming on-chain… this can take a minute on Ethereum.'));
  let ok = false;
  for (let k = 0; k < 60; k++) { try { if (await s.verify()) { ok = true; break; } } catch {} await sleep(3000); }
  if (!ok) { s.state = 'fail'; renderSteps(); stepFail(i, new Error('Not confirmed yet — the transaction may still be mining, or it may have failed.'), { recheck: true, retry: true }); return; }
  s.state = 'done'; renderSteps();
  flow.i = i + 1;
  if (flow.i < flow.steps.length) prepareStep(flow.i); else await finalize();
}
function errCode(err, i) {
  const s = (err?.shortMessage || err?.reason || err?.info?.error?.message || err?.message || '').toUpperCase();
  let r = 'FAIL';
  if (/ACTION_REJECTED|USER (DENIED|REJECTED)|4001/.test(s)) r = 'REJECTED';
  else if (/ALLOWANCE|EXCEEDS ALLOWANCE|TRANSFER_FROM/.test(s)) r = 'ALLOWANCE';
  else if (/MEMBERS ONLY/.test(s)) r = 'MEMBERS';
  else if (/PER-WALLET CAP/.test(s)) r = 'WALLET-CAP';
  else if (/PROGRAM FULL/.test(s)) r = 'FULL';
  else if (/INSUFFICIENT FUNDS|GAS REQUIRED/.test(s)) r = 'FUNDS';
  else if (/CALL_EXCEPTION|REVERT/.test(s)) r = 'REVERTED';
  return `${flow.steps[i]?.code || ('S' + (i + 1))}-${r}`;
}
function niceErr(err) {
  const s = err?.shortMessage || err?.reason || err?.info?.error?.message || err?.message || 'Transaction failed.';
  if (/ACTION_REJECTED|user rejected|4001/i.test(s)) return 'You dismissed the wallet prompt — no problem, just retry when ready.';
  if (/members only/i.test(s)) return 'This wallet is not on the member list. Staking is members-only.';
  if (/per-wallet cap/i.test(s)) return 'This would exceed your 100 $PC wallet limit.';
  if (/program full/i.test(s)) return 'The program has reached its cap — new locks are closed.';
  if (/insufficient funds/i.test(s)) return 'Not enough ETH to cover gas. Top up ETH and retry.';
  return s;
}
function stepFail(i, err, opts) {
  const s = flow.steps[i];
  const code = errCode(err, i);
  $('stepAct').innerHTML = '';
  if (opts.recheck) {
    const rc = document.createElement('button'); rc.className = 'go'; rc.type = 'button';
    rc.textContent = `Check step ${i + 1} again`; rc.onclick = () => verifyStep(i);
    $('stepAct').append(rc);
  }
  if (opts.retry) {
    const rb = document.createElement('button'); rb.className = 'go retry'; rb.type = 'button';
    rb.style.marginTop = opts.recheck ? '8px' : '';
    rb.textContent = `Retry step ${i + 1} — ${s.act}`; rb.onclick = () => runStep(i);
    $('stepAct').append(rb);
  }
  const hint = document.createElement('div'); hint.className = 'hint'; hint.id = 'stepHint';
  const both = opts.recheck && opts.retry
    ? ' If your wallet shows the transaction <b>succeeded</b>, use <b>Check again</b>. Only <b>Retry</b> if it failed or was never sent.'
    : '';
  hint.innerHTML = `⚠️ ${esc(niceErr(err))}${both}<br><span style="color:#7f8fb0">Nothing was lost. Error code <code>${code}</code> — quote it in <a href="${CFG.discordUrl}" target="_blank" rel="noopener">support</a> if it keeps failing.</span>`;
  $('stepAct').append(hint);
  status(`Step ${i + 1} needs attention (${code}).`, 'err');
}

/* ---------------- stake flow ---------------- */
async function startStake(e) {
  e.preventDefault();
  try {
    if (!account) return status('Connect your wallet first.', 'err');
    if (notDeployed()) return status('Preview build — staking opens at launch.', 'err');
    const amtStr = $('amount').value.trim();
    if (!amtStr || Number(amtStr) <= 0) return status('Enter an amount.', 'err');
    const amount = ethers.parseUnits(amtStr, 18);
    if (amount > await pcTokenRead.balanceOf(account)) return status('Amount exceeds your $PC balance.', 'err');
    const termDays = Number($('term').value);
    const bps = Number($('term').selectedOptions[0].dataset.bps || 0);

    resetFlow();
    const ctx = { amount, amtStr, termDays, bps };
    flow = {
      i: 0, ctx,
      steps: [
        {
          code: 'APPRV-PC', label: 'Approve $PC', act: 'Approve $PC',
          sub: 'Lets the staking contract lock exactly the $PC you chose.',
          precheck: async () => (await pcTokenRead.allowance(account, CFG.stakeVaultAddress)) >= amount,
          run: async () => pcToken.approve(CFG.stakeVaultAddress, amount),
          verify: async () => (await pcTokenRead.allowance(account, CFG.stakeVaultAddress)) >= amount,
        },
        {
          code: 'LOCK', label: `Lock ${amtStr} $PC for ${termDays} days`, act: 'Lock $PC',
          sub: 'Creates a new lock — your rate is fixed on-chain the moment this confirms.',
          run: async () => { ctx.beforeN = (await vaultRead.positionsOf(account)).length; return vault.stake(amount, termDays); },
          verify: async () => {
            const list = await vaultRead.positionsOf(account);
            if (list.length > (ctx.beforeN ?? 0)) { ctx.posId = list.length - 1; ctx.rate = Number(list[list.length - 1].rewardRateBps); return true; }
            return false;
          },
        },
      ],
    };
    $('submit').style.display = 'none';
    $('steps').style.display = 'block';
    renderSteps();
    status('Follow the steps below — one wallet prompt at a time.');
    prepareStep(0);
  } catch (err) { console.error(err); status(err?.shortMessage || err?.message || 'Could not start.', 'err'); }
}

async function finalize() {
  const ctx = flow.ctx;
  addHist({ type: 'stake', text: `Locked ${ctx.amtStr} $PC @ ${(ctx.rate ?? ctx.bps) / 100}% for ${ctx.termDays} days (lock #${ctx.posId})` });
  $('stepAct').innerHTML = '';
  $('result').innerHTML =
    `✅ Locked <b>${esc(ctx.amtStr)} $PC</b> at <b>${(ctx.rate ?? ctx.bps) / 100}%</b> for ${ctx.termDays} days (lock #${ctx.posId}).` +
    `<div class="tstep" id="tOpen">${spin('Opening your rewards position on Pentagon Chain — two independent signers are verifying your lock (usually a few minutes)…')}</div>`;
  status('Lock confirmed. 🎉', 'ok');
  $('submit').style.display = ''; $('submit').disabled = false;
  $('amount').value = ''; quote();
  await Promise.all([refreshBalances(), refreshTranche(), refreshTermRates(), refreshLocks()]);
  // track the 2-of-2 opening on Pentagon Chain
  const id = stakeIdOf(account, ctx.posId);
  let ticks = 0;
  clearInterval(window._track);
  window._track = setInterval(async () => {
    if (++ticks > 120) { clearInterval(window._track); const t = $('tOpen'); if (t) t.innerHTML = 'Still opening — check "My locks" later, points will backfill from your lock time.'; return; }
    try {
      const p = await ledgerRead('positions', [id]);
      if (p.open) {
        clearInterval(window._track);
        const t = $('tOpen'); if (t) { t.classList.add('done'); t.innerHTML = `✅ Rewards position open on ${CFG.pcChainName} — points accrue from your lock time; claim up to once a week under "My locks".`; }
        refreshLocks();
      }
    } catch {}
  }, 5000);
}

/* ---------------- locks: list, claim, withdraw ---------------- */
const rowStatus = (i, msg, cls = '') => { const el = $('rs' + i); if (el) { el.innerHTML = msg; el.className = 'rs ' + cls; } };

async function refreshLocks() {
  const el = $('lockList');
  if (!account || !vaultRead) { el.innerHTML = '<div class="hempty">Locks appear here after launch.</div>'; return; }
  let list = [], early = false;
  try { list = await vaultRead.positionsOf(account); } catch { el.innerHTML = '<div class="hempty">Could not load locks — refresh in a moment.</div>'; return; }
  try { early = await vaultRead.emergencyUnlock(); } catch {}
  if (!list.length) { el.innerHTML = '<div class="hempty">No locks yet — your first stake shows up here.</div>'; return; }
  el.innerHTML = '';
  const now = Math.floor(Date.now() / 1000);
  list.forEach(async (p, i) => {
    const d = document.createElement('div');
    d.className = 'lock';
    const rate = (Number(p.rewardRateBps) / 100).toFixed(Number(p.rewardRateBps) % 100 ? 1 : 0);
    const end = Number(p.lockEnd);
    const daysLeft = Math.max(0, Math.ceil((end - now) / 86400));
    const canWithdraw = !p.withdrawn && (now >= end || early);
    const stateTxt = p.withdrawn
      ? 'principal withdrawn ✓'
      : now >= end ? '<b style="color:#9fe3bf">unlocked — you can withdraw your $PC</b>'
      : early ? `unlocks ${new Date(end * 1000).toLocaleDateString()} · <b style="color:#e0a26a">early unlock enabled (test)</b>`
      : `unlocks ${new Date(end * 1000).toLocaleDateString()} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left)`;
    d.innerHTML =
      `<div class="r1"><span>Lock #${i} · <b>${fmtPC(p.amount)} $PC</b> @ ${rate}%</span><span>${Number(p.termDays)}d</span></div>` +
      `<div class="r2">${stateTxt}</div>` +
      `<div class="r2" id="pend${i}">PG Points: checking…</div>` +
      `<div class="rs" id="rs${i}"></div>` +
      `<div class="r3">` +
      `<button type="button" id="claim${i}" disabled>Claim PG Points ($PC on Pentagon Chain)</button>` +
      (canWithdraw ? `<button type="button" class="w" id="wd${i}">Withdraw ${fmtPC(p.amount)} $PC</button>` : '') +
      `</div>`;
    el.appendChild(d);
    const wd = $('wd' + i); if (wd) wd.onclick = () => withdrawLock(i, p);
    try {
      const id = stakeIdOf(account, i);
      const pos = await ledgerRead('positions', [id]);
      const [pend] = await ledgerRead('pending', [id]);
      const [nca] = await ledgerRead('nextClaimAt', [id]);
      // Claimed-so-far, always from chain (durable — never browser memory).
      // Prefer the ledger's exact totalClaimed(); older deployments without it
      // fall back to deriving it: total claimed == accrual(start -> lastClaim).
      let claimed;
      try { [claimed] = await ledgerRead('totalClaimed', [id]); }
      catch { claimed = (pos.amount * BigInt(pos.rewardRateBps) * (BigInt(pos.lastClaim) - BigInt(pos.start))) / 10000n / 31536000n; }
      const ready = pend > 0n && now >= Number(nca);
      // per-day accrual so the (necessarily small) numbers make sense
      const perDay = (p.amount * BigInt(p.rewardRateBps)) / 10000n / 365n;
      let line = `PG Points claimed so far: <b style="color:#ffd76a">${fmtPoints(claimed)}</b> · accruing now: <b>${fmtPoints(pend)}</b>`
        + `<br><span style="color:#b39a55">earning ≈ ${fmtPoints(perDay)} PG Points/day</span>`;
      if (p.withdrawn) line += '';
      else if (ready) line += ' · <b style="color:#58e08f">✅ claimable now</b>';
      else if (pend > 0n) line += ` · next claim in ${fmtDur(Number(nca) - now)} (${new Date(Number(nca) * 1000).toLocaleTimeString()})`;
      $('pend' + i).innerHTML = line;
      const btn = $('claim' + i);
      btn.disabled = !ready;
      btn.title = ready ? '' : `Claimable once per ${fmtDur(Number(nca) - Number(pos.lastClaim))}`;
      btn.onclick = () => claimLock(i, pend);
    } catch { $('pend' + i).textContent = 'PG Points: opening on Pentagon Chain… (check back shortly)'; }
  });
}

/* Claim — guided, step-by-step in the lock row. */
async function claimLock(i, pendBefore) {
  const btn = $('claim' + i); if (btn) btn.disabled = true;
  try {
    if (CFG.pcChainIdHex === '0x0') { rowStatus(i, 'Pentagon Chain network config pending.', 'err'); return; }
    rowStatus(i, spin(`Step 1 of 3 — switching your wallet to ${CFG.pcChainName}… (approve the switch in your wallet)`));
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CFG.pcChainIdHex }] });
    } catch (e) {
      if (e.code === 4902) {
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: CFG.pcChainIdHex, chainName: CFG.pcChainName,
          nativeCurrency: { name: 'PC', symbol: 'PC', decimals: 18 },
          rpcUrls: [CFG.pcRpcUrl], blockExplorerUrls: [CFG.pcExplorerBase],
        }] });
      } else throw e;
    }
    rowStatus(i, spin('Step 2 of 3 — confirm the claim in your wallet…'));
    const pcProvider = new ethers.BrowserProvider(window.ethereum);
    const ledger = new ethers.Contract(CFG.ledgerAddress, LEDGER, await pcProvider.getSigner());
    const id = stakeIdOf(account, i);
    const tx = await ledger.claim(id);
    rowStatus(i, spin('Step 3 of 3 — confirming on Pentagon Chain…'));
    // poll state (never trust tx.wait): pending should drop / lastClaim advance
    let ok = false;
    for (let k = 0; k < 40; k++) { try { const [p2] = await ledgerRead('pending', [id]); if (p2 < pendBefore) { ok = true; break; } } catch {} await sleep(3000); }
    if (!ok) { rowStatus(i, `Sent — taking longer than usual. <a target="_blank" rel="noopener" href="${CFG.pcExplorerBase}/tx/${tx.hash}?tab=internal_txns">view tx</a>`, ''); return; }
    rowStatus(i, `✅ Claimed ${fmtPoints(pendBefore)} PG Points · <a target="_blank" rel="noopener" href="${CFG.pcExplorerBase}/tx/${tx.hash}?tab=internal_txns">tx</a> · you can switch your wallet back to ${CFG.ethChainName}.`, 'ok');
    addHist({ type: 'claim', text: `Claimed ${fmtPoints(pendBefore)} PG Points (lock #${i})`, tx: tx.hash, pcTx: true });
    showFlash(pendBefore, tx.hash);
    refreshLocks();
  } catch (err) {
    console.error(err);
    const code = /ACTION_REJECTED|user rejected|4001/i.test(err?.message || '') ? 'CLAIM-REJECTED' : /once per interval/i.test(err?.message || '') ? 'CLAIM-THROTTLED' : /pool low/i.test(err?.message || '') ? 'CLAIM-POOL' : 'CLAIM-FAIL';
    rowStatus(i, `⚠️ ${esc(niceErr(err))} <span style="color:#7f8fb0">(code ${code})</span>`, 'err');
    if (btn) btn.disabled = false;
  }
}

/* Celebration flash after a successful claim. */
function showFlash(amountWei, txHash) {
  const f = $('flash'); if (!f) return;
  $("flashAmt").textContent = fmtPoints(amountWei);
  const a = $('flashTx');
  if (txHash) { a.style.display = 'inline'; a.href = `${CFG.pcExplorerBase}/tx/${txHash}?tab=internal_txns`; }
  else a.style.display = 'none';
  f.style.display = 'flex';
}

/* Withdraw principal — single guided step. */
async function withdrawLock(i, p) {
  const btn = $('wd' + i); if (btn) btn.disabled = true;
  try {
    rowStatus(i, spin(`Confirm in your wallet — withdrawing your ${fmtPC(p.amount)} $PC principal (on ${CFG.ethChainName})…`));
    const net = await provider.getNetwork();
    if ('0x' + net.chainId.toString(16) !== CFG.ethChainIdHex) {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CFG.ethChainIdHex }] });
      provider = new ethers.BrowserProvider(window.ethereum);
      signer = await provider.getSigner();
      vault = new ethers.Contract(CFG.stakeVaultAddress, VAULT, signer);
    }
    const tx = await vault.withdraw(i);
    rowStatus(i, spin('Submitted — confirming on-chain…'));
    let ok = false;
    for (let k = 0; k < 60; k++) { try { if ((await vaultRead.positionsOf(account))[i].withdrawn) { ok = true; break; } } catch {} await sleep(3000); }
    if (!ok) { rowStatus(i, `Sent — still confirming. <a target="_blank" rel="noopener" href="${CFG.explorerBase}/tx/${tx.hash}">view tx</a>`, ''); return; }
    rowStatus(i, `✅ ${fmtPC(p.amount)} $PC returned to your wallet · <a target="_blank" rel="noopener" href="${CFG.explorerBase}/tx/${tx.hash}">tx</a>`, 'ok');
    addHist({ type: 'withdraw', text: `Withdrew ${fmtPC(p.amount)} $PC principal (lock #${i})`, tx: tx.hash });
    await Promise.all([refreshBalances(), refreshLocks()]);
  } catch (err) {
    console.error(err);
    rowStatus(i, `⚠️ ${esc(niceErr(err))} <span style="color:#7f8fb0">(code WD-${/ACTION_REJECTED|user rejected/i.test(err?.message || '') ? 'REJECTED' : 'FAIL'})</span>`, 'err');
    if (btn) btn.disabled = false;
  }
}

/* ---------------- wiring ---------------- */
window.addEventListener('DOMContentLoaded', async () => {
  // First-ever visit: land once on the full program guide (the exciting brief),
  // which links back here; after that, straight to terms gate / app.
  if (localStorage.getItem(GUIDE_KEY) !== '1' && localStorage.getItem(AGREED_KEY) !== '1') {
    try { localStorage.setItem(GUIDE_KEY, '1'); } catch {}
    location.replace('details.html');
    return;
  }
  $('tosbox')?.addEventListener('scroll', checkTosScroll);
  showGate(false);
  $('agree').addEventListener('click', agree);
  $('showterms').addEventListener('click', (e) => { e.preventDefault(); showGate(true); });
  $('showterms2').addEventListener('click', (e) => { e.preventDefault(); showGate(true); });

  $('connect').addEventListener('click', connect);
  $('form').addEventListener('submit', startStake);
  $('amount').addEventListener('input', () => { resetFlow(); quote(); });
  $('term').addEventListener('change', quote);
  $('max').addEventListener('click', async () => {
    if (!account) return;
    let b = await pcToken.balanceOf(account);
    let cap = ethers.parseUnits(CFG.maxPerWallet, 18), mine = 0n;
    if (vault) { try { [mine, cap] = await Promise.all([vault.stakedByStaker(account), vault.maxStakePerStaker()]); } catch {} }
    const room = cap > mine ? cap - mine : 0n;
    if (b > room) b = room;
    $('amount').value = ethers.formatUnits(b, 18);
    quote();
  });
  $('clearHist').addEventListener('click', clearHist);
  $('flashClose').addEventListener('click', () => { $('flash').style.display = 'none'; });

  if (window.ethereum) window.ethereum.on?.('accountsChanged', () => location.reload());

  initReadProviders();   // reads never depend on which chain the wallet is on
  renderHist();
  await refreshTranche();
  await refreshTermRates();
});
