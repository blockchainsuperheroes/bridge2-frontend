// $PC Commitment Rewards — frontend config.
// ⚠ TEST DEPLOYMENT (disposable): fast params (1-day min lock, 5-min claim,
// instant-withdraw, open to any wallet). Not the production instance.
window.PCSTAKE_CONFIG = {
  // Ethereum (principal side)
  ethChainIdHex: '0x1',
  ethChainName: 'Ethereum',
  // Read-only ETH RPCs — used for all reads so "My locks" keeps working even
  // while the wallet is switched to Pentagon Chain during a claim.
  // A LIST, not one endpoint: public RPCs go down (publicnode outage broke the
  // page once). First responder wins; a dead entry is skipped automatically.
  ethRpcUrls: [
    'https://eth.drpc.org',
    'https://1rpc.io/eth',
    'https://ethereum-rpc.publicnode.com',
    'https://eth.llamarpc.com',
    'https://cloudflare-eth.com',
  ],
  pcTokenAddress: '0xA1Aa371E450C5AeE7fff259cbF5ccA9384227272', // $PC ERC-20 (18dp)
  stakeVaultAddress: '0xe31d31Ecb5Fbee1d142a26E44BEdC94C4DFb3B34', // PCStakeVault (TEST proxy)
  explorerBase: 'https://etherscan.io',

  // Pentagon Chain (rewards side)
  ledgerAddress: '0x04c1B7232f5575A3FEC4b221667CcE585F15F3C3', // PCStakeLedger (TEST proxy)
  pcChainName: 'Pentagon Chain',
  pcChainIdHex: '0xd10', // 3344
  pcRpcUrl: 'https://rpc.pentagon.games',
  pcExplorerBase: 'https://explorer.pentagon.games',

  // Same-origin Pages Function proxying read-only eth_call to the ledger
  // (pentagon.games sends no CORS; wallet writes are unaffected).
  ledgerRpcProxy: '/getPC2/rpc',
  // Off-chain claim policy check (advisory; the on-chain budget is the real
  // guard). Verifies the mirrored position is backed by a live Ethereum stake —
  // the one check Pentagon Chain cannot do — plus 24h volume limits.
  policyUrl: '/getPC2/policy',

  vipUrl: 'https://vip.pentagon.games/',
  termsAnchor: 'https://pentagon.games/PCtokenomics#not',
  discordUrl: 'https://discord.gg/pentagongamesxp',

  // Display fallback for the tranche table if the vault isn't reachable.
  fallbackSchedule: {
    ceilings: ['10000', '25000', '50000'],
    rates: [[8, 10, 14, 18], [6, 8, 11, 14], [5, 6, 8, 11]],
  },
  terms: [
    { days: 90,  label: '3 months'  },
    { days: 180, label: '6 months'  },
    { days: 365, label: '12 months' },
    { days: 730, label: '24 months' },
  ],
  maxPerWallet: '100', // $PC
};
