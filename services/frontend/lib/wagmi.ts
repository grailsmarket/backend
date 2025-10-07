import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import {
  mainnet,
  sepolia,
} from 'wagmi/chains';
import { ENABLE_TESTNETS } from './constants';

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'YOUR_PROJECT_ID';

const chains = ENABLE_TESTNETS ? [mainnet, sepolia] as const : [mainnet] as const;

export const config = getDefaultConfig({
  appName: 'Grails ENS Marketplace',
  projectId,
  chains,
  ssr: true,
});