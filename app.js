/* Pentagon Chain $PC top-up — one-way bridge with optional swap-and-bridge (Uniswap v2). */
const CFG = window.BRIDGE2_CONFIG;
const AGREED_KEY = 'pc_topup_agreed_v1';

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address,uint256) returns (bool)',
];
const VAULT = [
  'function deposit(uint256 amount, address recipient) returns (uint256)',
  'event Deposited(uint256 indexed depositId, address indexed from, address indexed recipient, uint256 amount, uint256 srcChainId, address vault)',
];
const ROUTER = [
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
];

const $ = (id) => document.getElementById(id);
const status = (m, k = '') => { const e = $('status'); e.textContent = m; e.className = k; };

let provider, signer, account, payWith = 'PC';
let pc, vault, router, quotedOut = 0n;
let poolBal = 0n, poolKnown = false;
const fmtPC = (v) => (+ethers.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 });

const TOK = () => ({
  PC:   { addr: CFG.pcTokenAddress, dp: 18, label: '$PC',  native: false },
  ETH:  { addr: null,               dp: 18, label: 'ETH',  native: true  },
  USDC: { addr: CFG.usdc,           dp: 6,  label: 'USDC', native: false },
}[payWith]);

/* ---------------- terms gate ---------------- */
function showGate(force) {
  if (!force && localStorage.getItem(AGREED_KEY) === '1') { enterApp(); return; }
  $('gate').style.display = 'flex'; $('app').style.display = 'none';
}
function enterApp() { $('gate').style.display = 'none'; $('app').style.display = 'block'; }
function agree() {
  if ($('dontshow').checked) localStorage.setItem(AGREED_KEY, '1');
  else localStorage.removeItem(AGREED_KEY);
  enterApp();
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
  pc = new ethers.Contract(CFG.pcTokenAddress, ERC20, signer);
  vault = new ethers.Contract(CFG.vaultAddress, VAULT, signer);
  router = new ethers.Contract(CFG.uniV2Router, ROUTER, signer);
  $('connect').textContent = account.slice(0, 6) + '…' + account.slice(-4);
  $('form').style.display = 'block';
  if (!$('recipient').value) $('recipient').value = account;
  await refreshBalance();
  await refreshPool();
  if (!window._poolTimer) window._poolTimer = setInterval(refreshPool, 30000);
}

async function tokenBalance() {
  const t = TOK();
  if (t.native) return provider.getBalance(account);
  const c = new ethers.Contract(t.addr, ERC20, provider);
  return c.balanceOf(account);
}
async function refreshBalance() {
  if (!account) return;
  const t = TOK();
  const b = await tokenBalance();
  $('balance').textContent = `${(+ethers.formatUnits(b, t.dp)).toLocaleString(undefined,{maximumFractionDigits:6})} ${t.label}`;
}

/* ---------------- bridge capacity (via PG-be proxy; pentagon.games has no CORS) ---------------- */
async function refreshPool() {
  if (!CFG.capacityUrl) { poolKnown = false; $('capacity').textContent = ''; checkCapacity(); return; }
  try {
    const r = await fetch(CFG.capacityUrl, { cache: 'no-store' });
    const j = await r.json();
    poolBal = BigInt(j.balanceWei ?? j.wei ?? '0');
    poolKnown = true;
    $('capacity').textContent = 'Bridge capacity: ' + fmtPC(poolBal) + ' PC available';
  } catch {
    poolKnown = false;
    $('capacity').textContent = 'Bridge capacity: unavailable';
  }
  checkCapacity();
}
function pcOutNow() {
  if (payWith === 'PC') {
    const a = $('amount').value.trim();
    try { return (a && Number(a) > 0) ? ethers.parseUnits(a, 18) : 0n; } catch { return 0n; }
  }
  return quotedOut;
}
function checkCapacity() {
  const warn = $('capWarn');
  if (!poolKnown) { warn.style.display = 'none'; $('submit').disabled = false; return true; } // fail open
  const need = pcOutNow();
  if (need > 0n && need > poolBal) {
    warn.style.display = 'block';
    warn.innerHTML = `Not enough bridge capacity right now — only <b>${fmtPC(poolBal)} PC</b> is available to receive. Please top up a smaller amount. Need more? Contact support at <a href="${CFG.discordUrl}" target="_blank" rel="noopener">${CFG.discordUrl.replace('https://','')}</a>.`;
    $('submit').disabled = true;
    return false;
  }
  warn.style.display = 'none';
  $('submit').disabled = false;
  return true;
}

/* ---------------- quote (Uniswap v2) ---------------- */
function pathFor() {
  if (payWith === 'ETH')  return [CFG.weth, CFG.pcTokenAddress];
  if (payWith === 'USDC') return [CFG.usdc, CFG.pcTokenAddress];
  return null;
}
async function refreshQuote() {
  quotedOut = 0n;
  const q = $('quote'), t = TOK();
  const amt = $('amount').value.trim();
  if (payWith === 'PC' || !amt || Number(amt) <= 0 || !router) { q.style.display = 'none'; return; }
  try {
    const amountIn = ethers.parseUnits(amt, t.dp);
    const amounts = await router.getAmountsOut(amountIn, pathFor());
    quotedOut = amounts[amounts.length - 1];
    const pcOut = +ethers.formatUnits(quotedOut, 18);
    const minOut = +ethers.formatUnits(quotedOut * BigInt(10000 - CFG.slippageBps) / 10000n, 18);
    q.style.display = 'block';
    q.innerHTML = `You receive ≈ <b>${pcOut.toLocaleString(undefined,{maximumFractionDigits:4})} $PC</b> <span style="color:#7fae95">(min ${minOut.toLocaleString(undefined,{maximumFractionDigits:4})} after ${CFG.slippageBps/100}% slippage, via Uniswap)</span>`;
  } catch { q.style.display = 'block'; q.innerHTML = '<span style="color:#e0a26a">No route / pool too thin for this size.</span>'; }
}

/* ---------------- top up (swap → deposit) ---------------- */
async function ensureAllowance(token, owner, spender, amount, label) {
  const c = new ethers.Contract(token, ERC20, signer);
  if ((await c.allowance(owner, spender)) < amount) {
    status(`Approving ${label}…`);
    await (await c.approve(spender, amount)).wait();
  }
}

async function submit(e) {
  e.preventDefault();
  try {
    if (CFG.vaultAddress.toLowerCase() === '0x0000000000000000000000000000000000000000') return status('Vault not configured.', 'err');
    if (!account) return status('Connect your wallet first.', 'err');
    const recipient = $('recipient').value.trim();
    if (!ethers.isAddress(recipient)) return status('Enter a valid Pentagon Chain address.', 'err');
    const amtStr = $('amount').value.trim();
    if (!amtStr || Number(amtStr) <= 0) return status('Enter an amount.', 'err');
    const t = TOK();
    const amountIn = ethers.parseUnits(amtStr, t.dp);
    const bal = await tokenBalance();
    if (amountIn > bal) return status(`Amount exceeds your ${t.label} balance.`, 'err');

    // bridge capacity guard — never lock PC the pool can't pay out (enforced only when capacity is known)
    await refreshPool();
    if (poolKnown) {
      let expectOut = amountIn;
      if (payWith !== 'PC') { if (quotedOut === 0n) await refreshQuote(); expectOut = quotedOut; }
      if (expectOut > 0n && expectOut > poolBal)
        return status(`Bridge capacity is only ${fmtPC(poolBal)} PC right now — top up less, or contact support: ${CFG.discordUrl}`, 'err');
    }

    let pcToDeposit;
    if (payWith === 'PC') {
      pcToDeposit = amountIn;
    } else {
      // 1) swap to PC via Uniswap v2, PC delivered to the user
      if (quotedOut === 0n) await refreshQuote();
      if (quotedOut === 0n) return status('No swap route available.', 'err');
      const minOut = quotedOut * BigInt(10000 - CFG.slippageBps) / 10000n;
      const deadline = Math.floor(Date.now() / 1000) + 1200;
      const before = await pc.balanceOf(account);
      status(`Swapping ${t.label} → $PC on Uniswap…`);
      let tx;
      if (payWith === 'ETH') {
        tx = await router.swapExactETHForTokens(minOut, pathFor(), account, deadline, { value: amountIn });
      } else {
        await ensureAllowance(t.addr, account, CFG.uniV2Router, amountIn, t.label);
        tx = await router.swapExactTokensForTokens(amountIn, minOut, pathFor(), account, deadline);
      }
      await tx.wait();
      const after = await pc.balanceOf(account);
      pcToDeposit = after - before;
      if (pcToDeposit <= 0n) return status('Swap returned no $PC.', 'err');
    }

    // 2) approve PC + deposit into the vault (one-way)
    await ensureAllowance(CFG.pcTokenAddress, account, CFG.vaultAddress, pcToDeposit, '$PC');
    status('Topping up (locking $PC)…');
    const dtx = await vault.deposit(pcToDeposit, recipient);
    status(`Top-up sent: ${dtx.hash}`);
    const rc = await dtx.wait();
    let depositId = '(see tx)';
    for (const lg of rc.logs) { try { const p = vault.interface.parseLog(lg); if (p?.name === 'Deposited') depositId = p.args.depositId.toString(); } catch {} }

    const pcAmt = (+ethers.formatUnits(pcToDeposit, 18)).toLocaleString(undefined,{maximumFractionDigits:4});
    $('result').innerHTML =
      `✅ Topped up <b>${pcAmt} $PC</b> (deposit #${depositId}).<br>` +
      `Tx: <a target="_blank" href="${CFG.explorerBase}/tx/${dtx.hash}">${dtx.hash.slice(0,10)}…</a><br>` +
      `In-ecosystem $PC will be credited to <code>${recipient.slice(0,6)}…${recipient.slice(-4)}</code> on ${CFG.pcChainName} after ~${CFG.minConfirmationsNote} confirmations. ` +
      `<a target="_blank" href="${CFG.pcExplorerBase}/address/${recipient}">Track</a>.`;
    status('Done.', 'ok');
    await refreshBalance();
  } catch (err) {
    console.error(err);
    status(err?.shortMessage || err?.reason || err?.message || 'Transaction failed.', 'err');
  }
}

/* ---------------- wiring ---------------- */
window.addEventListener('DOMContentLoaded', () => {
  showGate(false);
  $('agree').addEventListener('click', agree);
  $('showterms').addEventListener('click', (e) => { e.preventDefault(); showGate(true); });
  $('showterms2').addEventListener('click', (e) => { e.preventDefault(); showGate(true); });

  $('connect').addEventListener('click', connect);
  $('form').addEventListener('submit', submit);
  $('amount').addEventListener('input', () => { clearTimeout(window._q); window._q = setTimeout(async () => { await refreshQuote(); checkCapacity(); }, 350); });

  $('paywith').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pay]'); if (!b) return;
    payWith = b.dataset.pay;
    [...$('paywith').children].forEach(x => x.classList.toggle('sel', x === b));
    $('payLabel').textContent = TOK().label;
    $('amount').value = ''; $('quote').style.display = 'none'; quotedOut = 0n;
    $('swapNote').style.display = payWith === 'PC' ? 'none' : 'block';
    $('submit').textContent = payWith === 'PC' ? 'Top up' : `Swap ${TOK().label} & top up`;
    if (account) refreshBalance();
    checkCapacity();
  });

  $('max').addEventListener('click', async () => {
    if (!account) return;
    const t = TOK();
    let b = await tokenBalance();
    if (t.native) b = b > ethers.parseEther('0.01') ? b - ethers.parseEther('0.01') : 0n; // leave gas
    $('amount').value = ethers.formatUnits(b, t.dp);
    await refreshQuote(); checkCapacity();
  });

  if (window.ethereum) {
    window.ethereum.on?.('accountsChanged', () => location.reload());
    window.ethereum.on?.('chainChanged', () => location.reload());
  }
});
