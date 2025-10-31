export const SEAPORT_ADDRESS = process.env.NEXT_PUBLIC_SEAPORT_ADDRESS || '0x0000000000000068F116a894984e2DB1123eB395'; // Seaport 1.6
export const ENS_REGISTRAR_ADDRESS = process.env.NEXT_PUBLIC_ENS_REGISTRAR || '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
export const ENS_NAME_WRAPPER_ADDRESS = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';
export const WETH_ADDRESS = process.env.NEXT_PUBLIC_WETH_ADDRESS || '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // Mainnet WETH
export const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // Mainnet USDC

// Token decimals
export const TOKEN_DECIMALS = {
  ETH: 18,
  WETH: 18,
  USDC: 6,
} as const;

// Conduit Configuration
export const CONDUIT_CONTROLLER_ADDRESS = '0x00000000F9490004C11Cef243f5400493c00Ad63';
// TODO: Replace with actual deployed conduit address
export const MARKETPLACE_CONDUIT_ADDRESS = process.env.NEXT_PUBLIC_CONDUIT_ADDRESS || '0x73E9cD721a79C208E2F944910c27196307a2a05D'; // Placeholder
// TODO: Replace with actual conduit key
export const MARKETPLACE_CONDUIT_KEY = process.env.NEXT_PUBLIC_CONDUIT_KEY || '0xC9C3A4337a1bba75D0860A1A81f7B990dc607334000000000000000000000000'; // Placeholder

// OpenSea's conduit for reference/fallback
export const OPENSEA_CONDUIT_ADDRESS = '0x1E0049783F008A0085193E00003D00cd54003c71';
export const OPENSEA_CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';
export const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719';
export const OPENSEA_FEE_BASIS_POINTS = 100; // 1% = 100 basis points

// Grails Marketplace Fees
export const GRAILS_FEE_ENABLED = process.env.NEXT_PUBLIC_FEE_ENABLED === 'true';
export const GRAILS_FEE_RECIPIENT = process.env.NEXT_PUBLIC_FEE_RECEIVER_ADDRESS || '';
export const GRAILS_FEE_BASIS_POINTS = parseInt(process.env.NEXT_PUBLIC_FEE_BASIS_POINTS || '250'); // 2.5% = 250 basis points

// Configuration flag to enable/disable conduit usage
// Default to true since we have a deployed conduit
export const USE_CONDUIT = process.env.NEXT_PUBLIC_USE_CONDUIT !== 'false';

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1';
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3000/ws';

export const CHAIN_ID = parseInt(process.env.NEXT_PUBLIC_CHAIN_ID || '1');
export const ENABLE_TESTNETS = process.env.NEXT_PUBLIC_ENABLE_TESTNETS === 'true';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Seaport Order Types
export const OrderType = {
  FULL_OPEN: 0,
  PARTIAL_OPEN: 1,
  FULL_RESTRICTED: 2,
  PARTIAL_RESTRICTED: 3,
  CONTRACT: 4,
} as const;

export const ItemType = {
  NATIVE: 0,
  ERC20: 1,
  ERC721: 2,
  ERC1155: 3,
  ERC721_WITH_CRITERIA: 4,
  ERC1155_WITH_CRITERIA: 5,
} as const;