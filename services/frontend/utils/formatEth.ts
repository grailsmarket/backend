/**
 * Format wei to ETH with specified decimals
 */
export function formatEth(wei: string | null | undefined, decimals: number = 3): string {
  if (!wei || parseFloat(wei) === 0) return '—';
  return (parseFloat(wei) / 1e18).toFixed(decimals);
}

/**
 * Format wei to ETH with smart decimals (K for thousands)
 */
export function formatEthShort(wei: string | null | undefined): string {
  if (!wei || parseFloat(wei) === 0) return '—';
  const eth = parseFloat(wei) / 1e18;
  if (eth >= 1000) return `${(eth / 1000).toFixed(1)}K`;
  if (eth >= 1) return eth.toFixed(2);
  return eth.toFixed(3);
}
