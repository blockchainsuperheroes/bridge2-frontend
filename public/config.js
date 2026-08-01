// Frontend config.
window.BRIDGE2_CONFIG = {
  // Ethereum
  ethChainIdHex: '0x1', // mainnet
  ethChainName: 'Ethereum',
  pcTokenAddress: '0xA1Aa371E450C5AeE7fff259cbF5ccA9384227272', // $PC ERC-20 on ETH (18dp)
  vaultAddress: '0xe6A874c3C4c6353f69F485A5e49837A51eC06F4a',   // PCDepositVault

  // Swap-and-bridge (Uniswap v2)
  uniV2Router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  weth:        '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  usdc:        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // 6dp
  slippageBps: 100, // 1.0%

  // Pentagon Chain (destination — payout is automatic via keeper)
  pcChainName: 'Pentagon Chain',
  pcRpcUrl: 'https://rpc.pentagon.games',
  payoutAddress: '0x3eA48540A0cF76225aE6914F9A4D26c4c4f58bf4', // PCPayout pool (capacity check)
  // pentagon.games has no CORS -> browser can't read the pool directly.
  // Point this at a small PG-be endpoint that returns {"balanceWei":"<native PC wei>"}.
  // Empty => capacity check disabled (fails open; on-chain safety still applies).
  capacityUrl: '',
  // Optional: server-side endpoint reporting whether a deposit was paid out on
  // Pentagon Chain (browser can't read PC RPC — no CORS). Reads PCPayout.processed().
  //   GET <statusUrl>?depositId=&srcChainId=&srcVault=  ->  { credited, claimTx?, amount? }
  // Served same-origin by the Cloudflare Pages Function at functions/bridge/status.js.
  // Empty => the post-lock tracker shows ETH confirmations + an explorer link only.
  statusUrl: '/bridge/status',
  pcExplorerBase: 'https://explorer.pentagon.games',
  explorerBase: 'https://etherscan.io',
  minConfirmationsNote: 12,
  tokenomicsUrl: 'https://pentagon.games/PCtokenomics#not',
  discordUrl: 'https://discord.gg/pentagongamesxp',
};
