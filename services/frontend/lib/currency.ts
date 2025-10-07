import { WETH_ADDRESS, USDC_ADDRESS, TOKEN_DECIMALS } from './constants';

export function formatCurrencyAmount(
  amountWei: string,
  currencyAddress?: string
): string {
  // Default to zero address (ETH) if currency_address is not provided
  const normalizedAddress = (currencyAddress || '0x0000000000000000000000000000000000000000').toLowerCase();

  // Determine currency and decimals
  let currency = 'ETH';
  let decimals = TOKEN_DECIMALS.ETH;

  // Zero address means native ETH
  if (normalizedAddress === '0x0000000000000000000000000000000000000000') {
    currency = 'ETH';
    decimals = TOKEN_DECIMALS.ETH;
  } else if (normalizedAddress === USDC_ADDRESS.toLowerCase()) {
    currency = 'USDC';
    decimals = TOKEN_DECIMALS.USDC;
  } else if (normalizedAddress === WETH_ADDRESS.toLowerCase()) {
    currency = 'WETH';
    decimals = TOKEN_DECIMALS.WETH;
  }

  // Convert from smallest unit to human-readable
  const amount = Number(amountWei) / Math.pow(10, decimals);
  const formattedAmount = amount.toFixed(decimals === 6 ? 2 : 4);

  return `${formattedAmount} ${currency}`;
}

export function getCurrencyInfo(currencyAddress: string): {
  symbol: string;
  decimals: number;
} {
  const normalizedAddress = currencyAddress.toLowerCase();

  if (normalizedAddress === '0x0000000000000000000000000000000000000000') {
    return { symbol: 'ETH', decimals: TOKEN_DECIMALS.ETH };
  } else if (normalizedAddress === USDC_ADDRESS.toLowerCase()) {
    return { symbol: 'USDC', decimals: TOKEN_DECIMALS.USDC };
  } else if (normalizedAddress === WETH_ADDRESS.toLowerCase()) {
    return { symbol: 'WETH', decimals: TOKEN_DECIMALS.WETH };
  }

  return { symbol: 'ETH', decimals: TOKEN_DECIMALS.ETH };
}
