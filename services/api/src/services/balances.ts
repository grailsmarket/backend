import { ethers } from 'ethers';
import { config } from '../../../shared/src';

const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const WETH_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ENS_ADDRESS = '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72';

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) returns (tuple(bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
];

const BALANCE_OF_SELECTOR = '0x70a08231';

interface TokenBalance {
  symbol: string;
  address: string | null; // null for ETH
  wei: string;
  formatted: string;
  decimals: number;
}

export interface BalancesResult {
  eth: TokenBalance;
  weth: TokenBalance;
  usdc: TokenBalance;
  ens: TokenBalance;
}

export async function fetchBalances(address: string): Promise<BalancesResult> {
  const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrl);
  const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

  // Encode balanceOf calls for each ERC20 token
  const encodeBalanceOf = (addr: string) =>
    BALANCE_OF_SELECTOR + addr.slice(2).padStart(64, '0');

  const calls = [
    // ETH balance via Multicall3.getEthBalance
    {
      target: MULTICALL3_ADDRESS,
      allowFailure: true,
      callData: multicall.interface.encodeFunctionData('getEthBalance', [address]),
    },
    // WETH
    { target: WETH_ADDRESS, allowFailure: true, callData: encodeBalanceOf(address) },
    // USDC
    { target: USDC_ADDRESS, allowFailure: true, callData: encodeBalanceOf(address) },
    // ENS
    { target: ENS_ADDRESS, allowFailure: true, callData: encodeBalanceOf(address) },
  ];

  const results = await multicall.aggregate3.staticCall(calls);

  // Parse results
  const parseBalance = (result: { success: boolean; returnData: string }): bigint => {
    if (!result.success || result.returnData === '0x') return 0n;
    return BigInt(result.returnData);
  };

  const formatBalance = (wei: bigint, decimals: number): string => {
    return ethers.formatUnits(wei, decimals);
  };

  const ethWei = parseBalance(results[0]);
  const wethWei = parseBalance(results[1]);
  const usdcWei = parseBalance(results[2]);
  const ensWei = parseBalance(results[3]);

  return {
    eth: {
      symbol: 'ETH',
      address: null,
      wei: ethWei.toString(),
      formatted: formatBalance(ethWei, 18),
      decimals: 18,
    },
    weth: {
      symbol: 'WETH',
      address: WETH_ADDRESS,
      wei: wethWei.toString(),
      formatted: formatBalance(wethWei, 18),
      decimals: 18,
    },
    usdc: {
      symbol: 'USDC',
      address: USDC_ADDRESS,
      wei: usdcWei.toString(),
      formatted: formatBalance(usdcWei, 6),
      decimals: 6,
    },
    ens: {
      symbol: 'ENS',
      address: ENS_ADDRESS,
      wei: ensWei.toString(),
      formatted: formatBalance(ensWei, 18),
      decimals: 18,
    },
  };
}
