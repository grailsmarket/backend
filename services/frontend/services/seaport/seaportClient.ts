import { Seaport } from '@opensea/seaport-js';
import { ItemType } from '@opensea/seaport-js/lib/constants';
import { ethers } from 'ethers';
import {
  PublicClient,
  WalletClient,
  parseEther,
  Address,
  Hash,
  Hex,
  TypedDataDomain,
  BlockTag,
  keccak256,
  encodePacked,
  toHex
} from 'viem';
import {
  CreateOrderInput,
  OrderWithCounter,
  ConsiderationItem,
  OfferItem,
  ConsiderationInputItem,
  CreateInputItem,
  OrderComponents
} from '@opensea/seaport-js/lib/types';
import {
  SEAPORT_ADDRESS,
  ENS_REGISTRAR_ADDRESS,
  ENS_NAME_WRAPPER_ADDRESS,
  WETH_ADDRESS,
  USDC_ADDRESS,
  TOKEN_DECIMALS,
  USE_CONDUIT,
  MARKETPLACE_CONDUIT_ADDRESS,
  MARKETPLACE_CONDUIT_KEY,
  OPENSEA_CONDUIT_ADDRESS,
  OPENSEA_CONDUIT_KEY,
  OPENSEA_FEE_RECIPIENT,
  OPENSEA_FEE_BASIS_POINTS
} from '@/lib/constants';

// Type definitions for ethers compatibility
interface EthersTransaction {
  to?: Address;
  target?: Address; // ethers v6 might use 'target' instead of 'to'
  from?: Address;
  data?: Hex;
  value?: string | bigint;
  gasLimit?: string | bigint;
}

interface EthersTypedDataTypes {
  [key: string]: Array<{ name: string; type: string }>;
}

interface CollectionOfferTraits {
  [traitType: string]: string | number | boolean;
}

interface EthersSigner {
  getAddress: () => Promise<string>;
  signMessage: (message: string) => Promise<string>;
  signTypedData: (domain: TypedDataDomain, types: EthersTypedDataTypes, value: Record<string, unknown>) => Promise<string>;
  sendTransaction: (tx: EthersTransaction) => Promise<{
    hash: string;
    wait: () => Promise<unknown>;
    from: string;
    to?: string;
  }>;
  provider: {
    getNetwork: () => Promise<{ chainId: number }>;
    getBlockNumber: () => Promise<number>;
    getBalance: (address: string) => Promise<bigint>;
    getTransactionCount: (address: string) => Promise<number>;
    call: (tx: EthersTransaction) => Promise<string>;
    estimateGas: (tx: EthersTransaction) => Promise<string>;
    getGasPrice: () => Promise<string>;
    getBlock: (blockNumber: BlockTag | bigint) => Promise<unknown>;
    getTransaction: (hash: Hash) => Promise<unknown>;
  };
  _isSigner: boolean;
}

// Ethers-compatible constants
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

// Helper function to parse amount with correct decimals
function parseAmount(amount: string, decimals: number): bigint {
  const [whole, fraction = ''] = amount.split('.');
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole + paddedFraction);
}

export class SeaportClient {
  private seaport: Seaport | null = null;
  private publicClient: PublicClient | null = null;
  private walletClient: WalletClient | null = null;

  /**
   * Initialize Seaport client with viem clients
   */
  async initialize(publicClient: PublicClient, walletClient?: WalletClient) {
    this.publicClient = publicClient;
    this.walletClient = walletClient || null;

    try {
      // Try to use ethers directly with window.ethereum if available
      if (typeof window !== 'undefined' && (window as any).ethereum && walletClient) {
        console.log('Using ethers BrowserProvider for Seaport');
        const provider = new ethers.BrowserProvider((window as any).ethereum);
        const signer = await provider.getSigner();

        this.seaport = new Seaport(signer, {
          overrides: {
            contractAddress: SEAPORT_ADDRESS,
          },
          conduitKeyToConduit: {
            [MARKETPLACE_CONDUIT_KEY]: MARKETPLACE_CONDUIT_ADDRESS,
            [OPENSEA_CONDUIT_KEY]: OPENSEA_CONDUIT_ADDRESS,
          },
        });
      } else if (walletClient) {
        // Fallback to our custom wrapper
        const signer = this.createViemSigner(publicClient, walletClient);
        console.log('Initializing Seaport with custom signer, contract:', SEAPORT_ADDRESS);
        this.seaport = new Seaport(signer, {
          overrides: {
            contractAddress: SEAPORT_ADDRESS,
          },
          conduitKeyToConduit: {
            [MARKETPLACE_CONDUIT_KEY]: MARKETPLACE_CONDUIT_ADDRESS,
            [OPENSEA_CONDUIT_KEY]: OPENSEA_CONDUIT_ADDRESS,
          },
        });
      } else {
        // When we only have a public client, pass a provider
        const provider = this.createViemProvider(publicClient);
        this.seaport = new Seaport(provider, {
          overrides: {
            contractAddress: SEAPORT_ADDRESS,
          },
          conduitKeyToConduit: {
            [MARKETPLACE_CONDUIT_KEY]: MARKETPLACE_CONDUIT_ADDRESS,
            [OPENSEA_CONDUIT_KEY]: OPENSEA_CONDUIT_ADDRESS,
          },
        });
      }
    } catch (error) {
      console.error('Error initializing Seaport, falling back to custom wrapper:', error);

      if (walletClient) {
        const signer = this.createViemSigner(publicClient, walletClient);
        this.seaport = new Seaport(signer, {
          overrides: {
            contractAddress: SEAPORT_ADDRESS,
          },
          conduitKeyToConduit: {
            [MARKETPLACE_CONDUIT_KEY]: MARKETPLACE_CONDUIT_ADDRESS,
            [OPENSEA_CONDUIT_KEY]: OPENSEA_CONDUIT_ADDRESS,
          },
        });
      } else {
        const provider = this.createViemProvider(publicClient);
        this.seaport = new Seaport(provider, {
          overrides: {
            contractAddress: SEAPORT_ADDRESS,
          },
          conduitKeyToConduit: {
            [MARKETPLACE_CONDUIT_KEY]: MARKETPLACE_CONDUIT_ADDRESS,
            [OPENSEA_CONDUIT_KEY]: OPENSEA_CONDUIT_ADDRESS,
          },
        });
      }
    }
  }

  /**
   * Create an ethers-compatible signer wrapper for viem
   */
  private createViemSigner(publicClient: PublicClient, walletClient: WalletClient): EthersSigner {
    if (!walletClient.account) {
      throw new Error('WalletClient must have an account');
    }
    const signer = {
      address: walletClient.account.address, // Add address property
      getAddress: async () => {
        if (!walletClient.account) throw new Error('No account connected');
        return walletClient.account.address;
      },
      signMessage: async (message: string) => {
        if (!walletClient.account) throw new Error('No account connected');
        return await walletClient.signMessage({
          account: walletClient.account,
          message
        });
      },
      signTypedData: async (domain: TypedDataDomain, types: EthersTypedDataTypes, value: Record<string, unknown>) => {
        if (!walletClient.account) throw new Error('No account connected');
        return await walletClient.signTypedData({
          account: walletClient.account,
          domain,
          types,
          primaryType: Object.keys(types).find(t => t !== 'EIP712Domain')!,
          message: value,
        });
      },
      sendTransaction: async (tx: EthersTransaction) => {
        if (!walletClient.account) throw new Error('No account connected');
        const toAddress = tx.to || tx.target;
        const hash = await walletClient.sendTransaction({
          account: walletClient.account,
          to: toAddress,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined
        });
        return {
          hash,
          wait: async () => await publicClient.waitForTransactionReceipt({ hash }),
          from: walletClient.account.address,
          to: toAddress,
        };
      },
      // Add provider property that Seaport.js expects
      provider: {
        getNetwork: async () => ({ chainId: Number(await publicClient.getChainId()) }),
        getBlockNumber: async () => Number(await publicClient.getBlockNumber()),
        getBalance: async (address: string) => await publicClient.getBalance({ address: address as `0x${string}` }),
        getTransactionCount: async (address: string) => await publicClient.getTransactionCount({ address: address as `0x${string}` }),
        call: async (tx: EthersTransaction) => {
          const toAddress = tx.to || tx.target;
          console.log('Provider.call invoked with:', { to: toAddress, data: tx.data?.slice(0, 10), hasValue: !!tx.value });
          if (!toAddress) {
            console.error('Call without address:', tx);
            throw new Error('Transaction "to" or "target" field is required');
          }
          const result = await publicClient.call({
            to: toAddress,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
          });
          return result.data || '0x';
        },
        // Add staticCall method that Seaport might be using
        staticCall: async (tx: EthersTransaction) => {
          const toAddress = tx.to || tx.target;
          console.log('Provider.staticCall invoked with:', { to: toAddress, data: tx.data?.slice(0, 10) });
          if (!toAddress) {
            console.error('StaticCall without address:', tx);
            throw new Error('Transaction "to" or "target" field is required for staticCall');
          }
          const result = await publicClient.call({
            to: toAddress,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
          });
          return result.data || '0x';
        },
        estimateGas: async (tx: EthersTransaction) => {
          const toAddress = tx.to || tx.target;
          if (!toAddress) {
            console.error('EstimateGas called without address:', tx);
            throw new Error('Transaction "to" or "target" field is required for gas estimation');
          }
          const result = await publicClient.estimateGas({
            to: toAddress,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
            account: walletClient.account?.address,
          });
          return result.toString();
        },
        getGasPrice: async () => {
          const price = await publicClient.getGasPrice();
          return price.toString();
        },
        getBlock: async (blockNumber: BlockTag | bigint) => {
          return await publicClient.getBlock({ blockNumber });
        },
        getTransaction: async (hash: Hash) => await publicClient.getTransaction({ hash }),
      }
    };

    // Add _isSigner property that ethers expects
    const ethersCompatibleSigner = signer as EthersSigner;
    ethersCompatibleSigner._isSigner = true;

    return ethersCompatibleSigner;
  }

  /**
   * Create an ethers-compatible provider wrapper for viem (read-only)
   */
  private createViemProvider(publicClient: PublicClient) {
    return {
      // Minimal ethers provider interface for Seaport.js
      getNetwork: async () => ({ chainId: Number(await publicClient.getChainId()) }),
      getBlockNumber: async () => Number(await publicClient.getBlockNumber()),
      getBalance: async (address: string) => await publicClient.getBalance({ address: address as `0x${string}` }),
      getTransactionCount: async (address: string) => await publicClient.getTransactionCount({ address: address as `0x${string}` }),
      call: async (tx: EthersTransaction) => {
        const toAddress = tx.to || tx.target;
        if (!toAddress) {
          console.error('Provider call without address:', tx);
          throw new Error('Transaction "to" or "target" field is required');
        }
        const result = await publicClient.call({
          to: toAddress,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
        });
        return result.data || '0x';
      },
      estimateGas: async (tx: EthersTransaction) => {
        const toAddress = tx.to || tx.target;
        if (!toAddress) {
          console.error('Provider estimateGas without address:', tx);
          throw new Error('Transaction "to" or "target" field is required');
        }
        const result = await publicClient.estimateGas({
          to: toAddress,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          account: tx.from as `0x${string}` | undefined,
        });
        return result.toString();
      },
      // Add staticCall for provider-only mode
      staticCall: async (tx: EthersTransaction) => {
        const toAddress = tx.to || tx.target;
        console.log('Provider.staticCall invoked with:', { to: toAddress, data: tx.data?.slice(0, 10) });
        if (!toAddress) {
          console.error('StaticCall without address:', tx);
          throw new Error('Transaction "to" or "target" field is required for staticCall');
        }
        const result = await publicClient.call({
          to: toAddress,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
        });
        return result.data || '0x';
      },
      getGasPrice: async () => {
        const price = await publicClient.getGasPrice();
        return price.toString();
      },
      getBlock: async (blockNumber: BlockTag | bigint) => {
        const blockTag = typeof blockNumber === 'bigint' ? blockNumber : undefined;
        return await publicClient.getBlock({ blockNumber: blockTag });
      },
      getTransaction: async (hash: Hash) => await publicClient.getTransaction({ hash }),
    };
  }

  /**
   * Convert a labelhash (used by base registrar) to namehash (used by NameWrapper)
   * For .eth names, we need to compute namehash('eth') first, then combine with labelhash
   */
  private labelhashToNamehash(labelhash: string): string {
    // The namehash of 'eth'
    const ETH_NODE = '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae';

    // Convert labelhash to bytes32 format
    const labelhashBigInt = BigInt(labelhash);
    const labelhashHex = toHex(labelhashBigInt, { size: 32 });

    // Combine the eth node with the labelhash to get the full namehash
    // namehash('name.eth') = keccak256(namehash('eth') + labelhash('name'))
    const combined = encodePacked(
      ['bytes32', 'bytes32'],
      [ETH_NODE as `0x${string}`, labelhashHex as `0x${string}`]
    );

    const namehash = keccak256(combined);
    return BigInt(namehash).toString();
  }

  /**
   * Get the current conduit configuration for the marketplace
   */
  getConduitConfig() {
    return {
      enabled: USE_CONDUIT,
      conduitAddress: USE_CONDUIT ? MARKETPLACE_CONDUIT_ADDRESS : null,
      conduitKey: USE_CONDUIT ? MARKETPLACE_CONDUIT_KEY : ZERO_HASH,
      approvalTarget: USE_CONDUIT ? MARKETPLACE_CONDUIT_ADDRESS : SEAPORT_ADDRESS,
      targetName: USE_CONDUIT ? 'marketplace conduit' : 'Seaport',
    };
  }

  /**
   * Check if an ENS name is wrapped
   */
  async checkIfNameIsWrapped(tokenId: string): Promise<boolean> {
    if (!this.publicClient) {
      throw new Error('Public client not initialized');
    }

    try {
      const registrarOwner = await this.publicClient.readContract({
        address: ENS_REGISTRAR_ADDRESS as `0x${string}`,
        abi: [
          {
            name: 'ownerOf',
            type: 'function',
            inputs: [{ name: 'tokenId', type: 'uint256' }],
            outputs: [{ name: '', type: 'address' }],
            stateMutability: 'view',
          },
        ],
        functionName: 'ownerOf',
        args: [BigInt(tokenId)],
      }) as Address;

      return registrarOwner.toLowerCase() === ENS_NAME_WRAPPER_ADDRESS.toLowerCase();
    } catch (error) {
      console.error('Error checking if name is wrapped:', error);
      return false;
    }
  }

  /**
   * Create a listing order for an ENS name
   */
  async createListingOrder(params: {
    tokenId: string;
    priceInEth: string;
    durationDays: number;
    offererAddress: string;
    royaltyBps?: number; // Basis points for royalty (e.g., 250 = 2.5%)
    royaltyRecipient?: string;
    marketplace: 'opensea' | 'grails' | 'both';
    currency?: 'ETH' | 'USDC'; // Payment currency
  }): Promise<OrderWithCounter | { opensea: OrderWithCounter; grails: OrderWithCounter }> {
    if (!this.seaport) {
      throw new Error('Seaport client not initialized');
    }

    if (!this.publicClient || !this.walletClient) {
      throw new Error('Wallet client required for creating listings');
    }

    // Handle different marketplace selections
    if (params.marketplace === 'both') {
      // Create orders for both marketplaces
      const openSeaOrder = await this.createListingOrderForMarketplace({
        ...params,
        marketplace: 'opensea'
      });
      const grailsOrder = await this.createListingOrderForMarketplace({
        ...params,
        marketplace: 'grails'
      });
      return { opensea: openSeaOrder, grails: grailsOrder };
    } else {
      // Create order for single marketplace
      return await this.createListingOrderForMarketplace(params);
    }
  }

  /**
   * Internal method to create a listing order for a specific marketplace
   */
  private async createListingOrderForMarketplace(params: {
    tokenId: string;
    priceInEth: string;
    durationDays: number;
    offererAddress: string;
    royaltyBps?: number;
    royaltyRecipient?: string;
    marketplace: 'opensea' | 'grails';
    currency?: 'ETH' | 'USDC';
  }): Promise<OrderWithCounter> {
    if (!this.seaport || !this.publicClient || !this.walletClient) {
      throw new Error('Seaport client not initialized');
    }

    // First, check if the user owns the ENS NFT
    // ENS names can be either unwrapped (owned directly) or wrapped (owned through NameWrapper)
    let actualOwner: Address | null = null;
    let isWrapped = false;

    try {
      // First, check the base registrar
      const registrarOwner = await this.publicClient.readContract({
        address: ENS_REGISTRAR_ADDRESS as `0x${string}`,
        abi: [
          {
            name: 'ownerOf',
            type: 'function',
            inputs: [{ name: 'tokenId', type: 'uint256' }],
            outputs: [{ name: '', type: 'address' }],
            stateMutability: 'view',
          },
        ],
        functionName: 'ownerOf',
        args: [BigInt(params.tokenId)],
      }) as Address;

      // If the NameWrapper owns it, check the wrapper for the actual owner
      if (registrarOwner.toLowerCase() === ENS_NAME_WRAPPER_ADDRESS.toLowerCase()) {
        isWrapped = true;
        console.log('ENS name is wrapped, checking NameWrapper for actual owner...');

        try {
          // The NameWrapper uses namehash instead of labelhash as tokenId
          const namehash = this.labelhashToNamehash(params.tokenId);
          console.log('Converting labelhash to namehash:', params.tokenId, '->', namehash);

          actualOwner = await this.publicClient.readContract({
            address: ENS_NAME_WRAPPER_ADDRESS as `0x${string}`,
            abi: [
              {
                name: 'ownerOf',
                type: 'function',
                inputs: [{ name: 'id', type: 'uint256' }],
                outputs: [{ name: 'owner', type: 'address' }],
                stateMutability: 'view',
              },
            ],
            functionName: 'ownerOf',
            args: [BigInt(namehash)],
          }) as Address;
        } catch (wrapperError) {
          console.error('Failed to get owner from NameWrapper:', wrapperError);
          throw new Error('This ENS name appears to be wrapped but we could not verify ownership');
        }
      } else {
        // Not wrapped, the registrar owner is the actual owner
        actualOwner = registrarOwner;
      }

      if (actualOwner.toLowerCase() !== params.offererAddress.toLowerCase()) {
        throw new Error(`You don't own this ENS name. Current owner: ${actualOwner}${isWrapped ? ' (wrapped)' : ''}`);
      }

      console.log(`ENS ownership verified. Name is ${isWrapped ? 'wrapped' : 'unwrapped'}`);
    } catch (error: any) {
      if (error.message?.includes("don't own")) {
        throw error;
      }
      throw new Error(`Failed to verify ENS ownership: ${error.message}`);
    }

    // Check if token transfer is approved
    // When using conduits, we approve the conduit address instead of Seaport directly
    const contractToApprove = isWrapped ? ENS_NAME_WRAPPER_ADDRESS : ENS_REGISTRAR_ADDRESS;

    // Determine which conduit/operator to approve based on marketplace
    let operatorToApprove: string;
    let approvalTarget: string;

    console.log('Determining approval target:', {
      marketplace: params.marketplace,
      USE_CONDUIT,
      MARKETPLACE_CONDUIT_ADDRESS,
      SEAPORT_ADDRESS,
      OPENSEA_CONDUIT_ADDRESS
    });

    if (params.marketplace === 'opensea') {
      operatorToApprove = OPENSEA_CONDUIT_ADDRESS;
      approvalTarget = 'OpenSea conduit';
    } else if (params.marketplace === 'grails') {
      // Force using the conduit for Grails marketplace
      // The conduit at 0x73E9cD721a79C208E2F944910c27196307a2a05D is deployed and ready
      operatorToApprove = MARKETPLACE_CONDUIT_ADDRESS; // Always use conduit for Grails
      approvalTarget = 'Grails conduit';
      console.log('Forcing Grails conduit usage:', MARKETPLACE_CONDUIT_ADDRESS);
    } else {
      throw new Error('Invalid marketplace specified');
    }

    console.log('Selected operator to approve:', {
      operatorToApprove,
      approvalTarget,
      isSeaportAddress: operatorToApprove.toLowerCase() === SEAPORT_ADDRESS.toLowerCase()
    });

    try {
      const isApproved = await this.publicClient.readContract({
        address: contractToApprove as `0x${string}`,
        abi: [
          {
            name: 'isApprovedForAll',
            type: 'function',
            inputs: [
              { name: 'owner', type: 'address' },
              { name: 'operator', type: 'address' },
            ],
            outputs: [{ name: '', type: 'bool' }],
            stateMutability: 'view',
          },
        ],
        functionName: 'isApprovedForAll',
        args: [params.offererAddress as Address, operatorToApprove as Address],
      }) as boolean;
console.log(`Approval status for ${operatorToApprove}:`, isApproved);
      // If not approved, request approval
      if (!isApproved) {
        console.log(`${approvalTarget} not approved on ${isWrapped ? 'NameWrapper' : 'ENS Registrar'}, requesting approval...`);
        if (USE_CONDUIT) {
          console.log(`Approving conduit at: ${operatorToApprove}`);
        }

        if (!this.walletClient.account) {
          throw new Error('No account connected');
        }

        const approvalHash = await this.walletClient.writeContract({
          account: this.walletClient.account,
          address: contractToApprove as `0x${string}`,
          abi: [
            {
              name: 'setApprovalForAll',
              type: 'function',
              inputs: [
                { name: 'operator', type: 'address' },
                { name: 'approved', type: 'bool' },
              ],
              outputs: [],
              stateMutability: 'nonpayable',
            },
          ],
          functionName: 'setApprovalForAll',
          args: [operatorToApprove as Address, true]
        });

        // Wait for approval transaction to be confirmed
        console.log('Waiting for approval transaction...', approvalHash);
        await this.publicClient.waitForTransactionReceipt({
          hash: approvalHash,
          confirmations: 1,
        });
        console.log('Approval confirmed');
      } else {
        console.log(`${approvalTarget} already approved on ${isWrapped ? 'NameWrapper' : 'ENS Registrar'}`);
      }
    } catch (error: any) {
      throw new Error(`Failed to approve ${approvalTarget}: ${error.message}`);
    }

    const startTime = Math.floor(Date.now() / 1000).toString();
    const endTime = (
      Math.floor(Date.now() / 1000) +
      params.durationDays * 24 * 60 * 60
    ).toString();

    // Determine currency settings
    const currency = params.currency || 'ETH';
    const isUSDC = currency === 'USDC';
    const decimals = isUSDC ? TOKEN_DECIMALS.USDC : TOKEN_DECIMALS.ETH;
    const currencyToken = isUSDC ? USDC_ADDRESS : ZERO_ADDRESS; // ETH uses zero address

    // Convert price to smallest unit (wei for ETH, base units for USDC)
    const priceInSmallestUnit = parseAmount(params.priceInEth, decimals);

    // Build consideration array (payment to seller + optional royalties + marketplace fees)
    const consideration: ConsiderationInputItem[] = [];

    let sellerAmount = priceInSmallestUnit;

    // Calculate OpenSea fee if listing on OpenSea
    if (params.marketplace === 'opensea') {
      const openSeaFee = (priceInSmallestUnit * BigInt(OPENSEA_FEE_BASIS_POINTS)) / BigInt(10000);
      sellerAmount = sellerAmount - openSeaFee;

      // Add OpenSea fee consideration
      consideration.push({
        token: currencyToken,
        amount: openSeaFee.toString(),
        endAmount: openSeaFee.toString(),
        recipient: OPENSEA_FEE_RECIPIENT,
      });
    }

    // Calculate royalty if specified
    if (params.royaltyBps && params.royaltyRecipient) {
      const royaltyAmount = (priceInSmallestUnit * BigInt(params.royaltyBps)) / BigInt(10000);
      sellerAmount = sellerAmount - royaltyAmount;

      // Add royalty consideration
      consideration.push({
        token: currencyToken,
        amount: royaltyAmount.toString(),
        endAmount: royaltyAmount.toString(),
        recipient: params.royaltyRecipient,
      });
    }

    // Primary consideration (payment to seller)
    consideration.unshift({
      token: currencyToken,
      amount: sellerAmount.toString(),
      endAmount: sellerAmount.toString(),
      recipient: params.offererAddress,
    });

    // Validate all addresses in consideration
    for (const item of consideration) {
      if (!item.recipient) {
        throw new Error('Consideration item missing recipient address');
      }
    }

    // Use the appropriate contract address and item type for the offer
    // Wrapped names are ERC-1155 tokens on NameWrapper
    // Unwrapped names are ERC-721 tokens on base registrar
    const tokenContract = isWrapped ? ENS_NAME_WRAPPER_ADDRESS : ENS_REGISTRAR_ADDRESS;
    const itemType = isWrapped ? ItemType.ERC1155 : ItemType.ERC721;

    // For wrapped names, use namehash; for unwrapped, use labelhash
    const tokenIdentifier = isWrapped ? this.labelhashToNamehash(params.tokenId) : params.tokenId;

    console.log('Token details for offer:', {
      tokenContract,
      tokenIdentifier,
      isWrapped,
      originalTokenId: params.tokenId,
      ENS_REGISTRAR_ADDRESS,
      ENS_NAME_WRAPPER_ADDRESS
    });

    // Validate token contract address
    if (!tokenContract) {
      throw new Error('Token contract address is undefined');
    }

    const offer: CreateInputItem[] = isWrapped
      ? [
          {
            itemType: ItemType.ERC1155,
            token: tokenContract,
            identifier: tokenIdentifier,
            amount: '1',
          },
        ]
      : [
          {
            itemType: ItemType.ERC721,
            token: tokenContract,
            identifier: tokenIdentifier,
          },
        ];

    // Determine conduit key based on marketplace
    let conduitKey: string | undefined;
    if (params.marketplace === 'opensea') {
      conduitKey = OPENSEA_CONDUIT_KEY;
    } else if (params.marketplace === 'grails' && USE_CONDUIT) {
      conduitKey = MARKETPLACE_CONDUIT_KEY;
    }

    // Include conduit key in order so Seaport knows to use the conduit
    const orderInput: CreateOrderInput = {
      offer,
      consideration,
      startTime,
      endTime,
      // Allow partial fills for bundle purchases
      allowPartialFills: false,
      // Restrict order to prevent unwanted transfers
      restrictedByZone: false,
      // Include conduit key so Seaport uses the conduit for transfers
      ...(conduitKey && { conduitKey }),
    };

    // Create the order
    console.log('Creating order with:', {
      marketplace: params.marketplace,
      offererAddress: params.offererAddress,
      conduitKey,
      seaportInitialized: !!this.seaport,
      isWrapped,
      tokenContract
    });

    console.log('Order input:', JSON.stringify(orderInput, null, 2));
    console.log('Seaport instance check:', {
      hasSeaport: !!this.seaport,
      seaportType: typeof this.seaport,
      hasPublicClient: !!this.publicClient,
      hasWalletClient: !!this.walletClient,
    });

    if (!params.offererAddress) {
      throw new Error('Offerer address is required');
    }

    // Extra validation to ensure no null/undefined values
    if (orderInput.offer.some(item => !item.token)) {
      throw new Error('Offer item missing token address');
    }
    if (orderInput.consideration.some(item => !item.recipient)) {
      throw new Error('Consideration item missing recipient');
    }

    let executeAllActions;
    try {
      const result = await this.seaport.createOrder(
        orderInput,
        params.offererAddress as `0x${string}`
      );
      executeAllActions = result.executeAllActions;
    } catch (error: any) {
      console.error('Seaport createOrder failed:', error);
      console.error('Error details:', {
        message: error.message,
        code: error.code,
        argument: error.argument,
        value: error.value
      });
      throw error;
    }

    // Execute all actions (including getting signature)
    const order = await executeAllActions();

    // Add metadata to order
    (order as any).isWrapped = isWrapped;
    (order as any).tokenContract = tokenContract;
    (order as any).marketplace = params.marketplace;
    // Store conduit key for reference but don't include in order parameters
    (order as any).conduitKey = conduitKey || '0x0000000000000000000000000000000000000000000000000000000000000000';

    return order;
  }

  /**
   * Create an offer order for an ENS name
   */
  async createOfferOrder(params: {
    tokenId: string;
    offerPriceInEth: string;
    durationDays: number;
    offererAddress: string;
    currentOwner?: string;
    isWrapped?: boolean; // Add parameter to know if name is wrapped
    currency?: 'WETH' | 'USDC'; // Payment currency for offers
  }): Promise<OrderWithCounter> {
    if (!this.seaport) {
      throw new Error('Seaport client not initialized');
    }

    const startTime = Math.floor(Date.now() / 1000).toString();
    const endTime = (
      Math.floor(Date.now() / 1000) +
      params.durationDays * 24 * 60 * 60
    ).toString();

    // Determine currency settings (offers must use ERC20, not native ETH)
    const currency = params.currency || 'WETH';
    const isUSDC = currency === 'USDC';
    const decimals = isUSDC ? TOKEN_DECIMALS.USDC : TOKEN_DECIMALS.WETH;
    const currencyToken = isUSDC ? USDC_ADDRESS : WETH_ADDRESS;

    // Convert price to smallest unit
    const offerAmount = parseAmount(params.offerPriceInEth, decimals);

    // Build offer items (what the offerer is giving)
    // NOTE: Seaport does NOT allow native ETH in offers, must use ERC20 (WETH or USDC)
    const offer: CreateInputItem[] = [
      {
        itemType: ItemType.ERC20,
        token: currencyToken,
        amount: offerAmount.toString(),
        endAmount: offerAmount.toString(),
      },
    ];

    // Determine contract and item type based on whether name is wrapped
    const tokenContract = params.isWrapped ? ENS_NAME_WRAPPER_ADDRESS : ENS_REGISTRAR_ADDRESS;
    const itemType = params.isWrapped ? ItemType.ERC1155 : ItemType.ERC721;

    // For wrapped names, use namehash; for unwrapped, use labelhash
    const tokenIdentifier = params.isWrapped ? this.labelhashToNamehash(params.tokenId) : params.tokenId;

    const consideration: ConsiderationInputItem[] = [
      params.isWrapped
        ? {
            itemType: ItemType.ERC1155,
            token: tokenContract,
            identifier: tokenIdentifier,
            amount: '1',
            recipient: params.offererAddress,
          }
        : {
            itemType: ItemType.ERC721,
            token: tokenContract,
            identifier: tokenIdentifier,
            recipient: params.offererAddress,
          },
    ];

    const orderInput: CreateOrderInput = {
      offer,
      consideration,
      startTime,
      endTime,
      allowPartialFills: false,
      // Include conduit key if using conduits
      ...(USE_CONDUIT && { conduitKey: MARKETPLACE_CONDUIT_KEY }),
      // If we know the current owner, we can restrict the order
      ...(params.currentOwner && {
        zone: ZERO_ADDRESS,
        zoneHash: ZERO_HASH,
      }),
    };

    // Create the order
    const { executeAllActions } = await this.seaport.createOrder(
      orderInput,
      params.offererAddress
    );

    // Execute all actions (including getting signature)
    const order = await executeAllActions();

    return order;
  }

  /**
   * Create a collection offer for any ENS name
   */
  async createCollectionOffer(params: {
    offerPriceInEth: string;
    durationDays: number;
    offererAddress: string;
    traits?: CollectionOfferTraits; // Optional trait-based offers
  }): Promise<OrderWithCounter> {
    if (!this.seaport) {
      throw new Error('Seaport client not initialized');
    }

    const startTime = Math.floor(Date.now() / 1000).toString();
    const endTime = (
      Math.floor(Date.now() / 1000) +
      params.durationDays * 24 * 60 * 60
    ).toString();

    // Convert ETH to Wei
    const offerInWei = parseEther(params.offerPriceInEth).toString();

    // For collection offers, we use criteria-based orders
    // This requires a merkle tree of valid token IDs or traits
    const offer: CreateInputItem[] = [
      {
        // For native ETH offers, use CurrencyItem (no itemType needed)
        token: ZERO_ADDRESS,
        amount: offerInWei,
        endAmount: offerInWei,
      },
    ];

    const consideration: ConsiderationInputItem[] = [
      {
        itemType: ItemType.ERC721,
        token: ENS_REGISTRAR_ADDRESS,
        // For collection offers, we'll use identifiers array or criteria
        identifiers: [], // This would be populated with valid token IDs
        recipient: params.offererAddress,
      },
    ];

    const orderInput: CreateOrderInput = {
      offer,
      consideration,
      startTime,
      endTime,
      allowPartialFills: false,
    };

    // Create the order
    const { executeAllActions } = await this.seaport.createOrder(
      orderInput,
      params.offererAddress
    );

    // Execute all actions (including getting signature)
    const order = await executeAllActions();

    return order;
  }

  /**
   * Fulfill an order (buy an ENS name)
   */
  async fulfillOrder(order: OrderWithCounter, fulfillerAddress: string) {
    if (!this.seaport || !this.walletClient) {
      throw new Error('Seaport client not initialized with signer');
    }

    const { executeAllActions } = await this.seaport.fulfillOrder({
      order,
      accountAddress: fulfillerAddress,
      // Include conduit key for fulfiller if using conduits
      ...(USE_CONDUIT && { conduitKey: MARKETPLACE_CONDUIT_KEY }),
    });

    const transaction = await executeAllActions();
    return transaction;
  }

  /**
   * Cancel orders
   */
  async cancelOrders(orders: OrderComponents[], offererAddress: string) {
    if (!this.seaport || !this.walletClient) {
      throw new Error('Seaport client not initialized with signer');
    }

    console.log('Cancelling orders:', { count: orders.length, offerer: offererAddress });

    const result = await this.seaport.cancelOrders(
      orders,
      offererAddress
    );

    console.log('Cancel result type:', typeof result, result);

    // The result is a ContractTransaction that needs to be sent via wallet
    if (result && typeof result === 'object') {
      // If it has a transact method, call it
      if ('transact' in result && typeof result.transact === 'function') {
        console.log('Calling transact()...');
        const tx = await result.transact();
        console.log('Transaction sent:', tx);
        return tx;
      }

      // If it has executeAllActions, use that
      if ('executeAllActions' in result && typeof result.executeAllActions === 'function') {
        console.log('Executing cancellation via executeAllActions...');
        const transaction = await result.executeAllActions();
        console.log('Cancellation transaction complete:', transaction);
        return transaction;
      }

      // If it has transaction data (to, data, value), send via walletClient
      if ('to' in result || 'data' in result) {
        console.log('Sending transaction via walletClient...');
        const hash = await this.walletClient.sendTransaction({
          to: result.to as `0x${string}`,
          data: result.data as `0x${string}`,
          value: result.value ? BigInt(result.value) : 0n,
          account: offererAddress as `0x${string}`,
          chain: this.walletClient.chain,
        });
        console.log('Transaction hash:', hash);

        // Wait for confirmation
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        console.log('Transaction confirmed:', receipt);
        return receipt;
      }
    }

    console.log('Unknown result format, returning as-is');
    return result;
  }

  /**
   * Validate an order
   */
  async validateOrder(order: OrderWithCounter): Promise<boolean> {
    if (!this.seaport) {
      throw new Error('Seaport client not initialized');
    }

    try {
      // validate returns a contract transaction, not a boolean
      await this.seaport.validate([order]);
      return true;
    } catch (error) {
      console.error('Order validation failed:', error);
      return false;
    }
  }

  /**
   * Get order status (filled, cancelled, etc.)
   */
  async getOrderStatus(orderHash: string) {
    if (!this.seaport) {
      throw new Error('Seaport client not initialized');
    }

    const status = await this.seaport.getOrderStatus(orderHash);
    return status;
  }

  /**
   * Build fulfillment transaction data without executing
   */
  async buildFulfillmentTransaction(
    order: OrderWithCounter,
    fulfillerAddress: string
  ) {
    if (!this.seaport) {
      throw new Error('Seaport client not initialized');
    }

    const { actions } = await this.seaport.fulfillOrder({
      order,
      accountAddress: fulfillerAddress,
    });

    // Get transaction data without executing
    const transactionData = await actions[0].transactionMethods.buildTransaction();
    return transactionData;
  }

  /**
   * Convert BigInt values in an object to strings for JSON serialization
   */
  private serializeBigInts(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'bigint') {
      return obj.toString();
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.serializeBigInts(item));
    }

    if (typeof obj === 'object') {
      const result: any = {};
      for (const key in obj) {
        result[key] = this.serializeBigInts(obj[key]);
      }
      return result;
    }

    return obj;
  }

  /**
   * Convert string values back to BigInts for Seaport parameters
   * Based on Seaport contract types:
   * - uint256 fields → BigInt
   * - bytes32 fields → string (hex)
   * - address fields → string (hex)
   */
  deserializeOrderParameters(params: any): any {
    if (!params) return params;

    // uint256 fields that must be BigInt
    const uint256Fields = [
      'startTime',      // uint256
      'endTime',        // uint256
      'salt',           // uint256
      'counter',        // uint256
      'totalOriginalConsiderationItems'  // uint256
    ];

    // bytes32 and address fields stay as strings
    // - zoneHash: bytes32
    // - conduitKey: bytes32
    // - offerer: address
    // - zone: address
    // - token: address
    // - recipient: address

    // OfferItem/ConsiderationItem uint256 fields
    const itemUint256Fields = [
      'startAmount',           // uint256
      'endAmount',             // uint256
      'identifierOrCriteria'   // uint256
    ];

    const result: any = { ...params };

    // Convert top-level uint256 fields to BigInt
    for (const field of uint256Fields) {
      if (result[field] !== undefined && result[field] !== null) {
        result[field] = BigInt(result[field]);
      }
    }

    // Convert offer items
    if (Array.isArray(result.offer)) {
      result.offer = result.offer.map((item: any) => {
        const newItem = { ...item };
        for (const field of itemUint256Fields) {
          if (newItem[field] !== undefined && newItem[field] !== null) {
            newItem[field] = BigInt(newItem[field]);
          }
        }
        return newItem;
      });
    }

    // Convert consideration items
    if (Array.isArray(result.consideration)) {
      result.consideration = result.consideration.map((item: any) => {
        const newItem = { ...item };
        for (const field of itemUint256Fields) {
          if (newItem[field] !== undefined && newItem[field] !== null) {
            newItem[field] = BigInt(newItem[field]);
          }
        }
        return newItem;
      });
    }

    return result;
  }

  /**
   * Format order for storage in database
   * Handles BigInt serialization to prevent JSON.stringify errors
   */
  formatOrderForStorage(order: OrderWithCounter) {
    // Check if order has marketplace metadata
    const marketplace = (order as any).marketplace || 'grails';
    const storedConduitKey = (order as any).conduitKey;

    // Determine which conduit info to store based on marketplace
    let conduitKey = '0x0000000000000000000000000000000000000000000000000000000000000000';
    let conduitAddress = null;

    if (marketplace === 'opensea') {
      conduitKey = OPENSEA_CONDUIT_KEY;
      conduitAddress = OPENSEA_CONDUIT_ADDRESS;
    } else if (marketplace === 'grails' && USE_CONDUIT) {
      conduitKey = MARKETPLACE_CONDUIT_KEY;
      conduitAddress = MARKETPLACE_CONDUIT_ADDRESS;
    }

    // Use stored conduit key if available
    if (storedConduitKey) {
      conduitKey = storedConduitKey;
    }

    // Serialize BigInt values to strings for JSON compatibility
    const serializedParameters = this.serializeBigInts(order.parameters);

    return {
      parameters: serializedParameters,
      signature: order.signature,
      // Include protocol metadata
      protocol_data: {
        parameters: serializedParameters,
        signature: order.signature,
        // Always include conduit key (even if zero)
        conduitKey,
        ...(conduitAddress && { conduitAddress }),
      },
      // Calculate order hash
      orderHash: this.seaport ? this.seaport.getOrderHash(order.parameters) : null,
      // Store marketplace and conduit info
      marketplace,
      usesConduit: conduitKey !== '0x0000000000000000000000000000000000000000000000000000000000000000',
    };
  }

  /**
   * Create an offer for an ENS name
   */
  async createOffer(params: {
    tokenId: string;
    priceInEth: string;
    durationDays: number;
    offererAddress: string;
    marketplace: 'opensea' | 'grails' | 'both';
  }): Promise<OrderWithCounter | { opensea: OrderWithCounter; grails: OrderWithCounter }> {
    if (!this.seaport) {
      throw new Error('Seaport client not initialized');
    }

    if (!this.publicClient || !this.walletClient) {
      throw new Error('Wallet client required for creating offers');
    }

    // Handle different marketplace selections
    if (params.marketplace === 'both') {
      // Create offers for both marketplaces
      const openSeaOffer = await this.createOfferForMarketplace({
        ...params,
        marketplace: 'opensea'
      });
      const grailsOffer = await this.createOfferForMarketplace({
        ...params,
        marketplace: 'grails'
      });
      return { opensea: openSeaOffer, grails: grailsOffer };
    } else {
      // Create offer for single marketplace
      return await this.createOfferForMarketplace(params as any);
    }
  }

  /**
   * Create offer for a specific marketplace
   */
  private async createOfferForMarketplace(params: {
    tokenId: string;
    priceInEth: string;
    durationDays: number;
    offererAddress: string;
    marketplace: 'opensea' | 'grails';
    currency?: 'WETH' | 'USDC';
  }): Promise<OrderWithCounter> {
    if (!this.seaport || !this.publicClient || !this.walletClient) {
      throw new Error('Seaport client not initialized');
    }

    const { tokenId, priceInEth, durationDays, offererAddress, marketplace } = params;

    // Determine conduit key based on marketplace
    const useOpenseaConduit = marketplace === 'opensea';
    const conduitKey = useOpenseaConduit ? OPENSEA_CONDUIT_KEY : (USE_CONDUIT ? MARKETPLACE_CONDUIT_KEY : '0x0000000000000000000000000000000000000000000000000000000000000000');

    // Calculate timestamps
    const startTime = Math.floor(Date.now() / 1000).toString();
    const endTime = (Math.floor(Date.now() / 1000) + (durationDays * 24 * 60 * 60)).toString();

    // Determine currency settings (offers must use ERC20, not native ETH)
    const currency = params.currency || 'WETH';
    const isUSDC = currency === 'USDC';
    const decimals = isUSDC ? TOKEN_DECIMALS.USDC : TOKEN_DECIMALS.WETH;
    const currencyToken = isUSDC ? USDC_ADDRESS : WETH_ADDRESS;
    const currencyName = isUSDC ? 'USDC' : 'WETH';

    // Convert price to smallest unit
    const priceInSmallestUnit = parseAmount(priceInEth, decimals);

    // Build consideration items (what the offerer wants - the NFT)
    const consideration: ConsiderationInputItem[] = [
      {
        itemType: ItemType.ERC721, // ENS NFT
        token: ENS_REGISTRAR_ADDRESS as `0x${string}`,
        identifier: tokenId,
        recipient: offererAddress as `0x${string}`,
      },
    ];

    // Build offer items (what the offerer is giving - WETH or USDC)
    // NOTE: Seaport does NOT allow native ETH in offers, must use ERC20
    const offer: CreateInputItem[] = [
      {
        itemType: ItemType.ERC20,
        token: currencyToken as `0x${string}`,
        amount: priceInSmallestUnit.toString(),
        endAmount: priceInSmallestUnit.toString(),
      },
    ];

    // Build additional recipients for fees
    const additionalRecipients: ConsiderationInputItem[] = [];

    // Add OpenSea fee if using OpenSea marketplace
    if (marketplace === 'opensea') {
      const openseaFee = (priceInSmallestUnit * BigInt(OPENSEA_FEE_BASIS_POINTS)) / BigInt(10000);
      additionalRecipients.push({
        itemType: ItemType.ERC20, // Fee also paid in same currency
        token: currencyToken as `0x${string}`,
        amount: openseaFee.toString(),
        endAmount: openseaFee.toString(),
        recipient: OPENSEA_FEE_RECIPIENT as `0x${string}`,
      });
    }

    // Check token balance and approval before creating the order
    const tokenBalance = await this.publicClient.readContract({
      address: currencyToken as `0x${string}`,
      abi: [
        {
          name: 'balanceOf',
          type: 'function',
          inputs: [{ name: 'account', type: 'address' }],
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
        },
      ],
      functionName: 'balanceOf',
      args: [offererAddress as `0x${string}`],
    }) as bigint;

    if (tokenBalance < priceInSmallestUnit) {
      const formattedBalance = Number(tokenBalance) / Math.pow(10, decimals);
      throw new Error(
        `Insufficient ${currencyName} balance. You have ${formattedBalance.toFixed(decimals === 6 ? 2 : 4)} ${currencyName} but need ${priceInEth} ${currencyName}.${isUSDC ? '' : ' Please wrap ETH to WETH first.'}`
      );
    }

    // Determine which address to approve based on conduit usage
    const approvalTarget = conduitKey !== '0x0000000000000000000000000000000000000000000000000000000000000000'
      ? (marketplace === 'opensea' ? OPENSEA_CONDUIT_ADDRESS : MARKETPLACE_CONDUIT_ADDRESS)
      : SEAPORT_ADDRESS;

    // Check token approval for Seaport/Conduit
    const tokenAllowance = await this.publicClient.readContract({
      address: currencyToken as `0x${string}`,
      abi: [
        {
          name: 'allowance',
          type: 'function',
          inputs: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
          ],
          outputs: [{ name: '', type: 'uint256' }],
          stateMutability: 'view',
        },
      ],
      functionName: 'allowance',
      args: [offererAddress as `0x${string}`, approvalTarget as `0x${string}`],
    }) as bigint;

    // If allowance is insufficient, request approval
    if (tokenAllowance < priceInSmallestUnit) {
      console.log(`Requesting ${currencyName} approval for ${marketplace === 'opensea' ? 'OpenSea conduit' : 'Seaport/conduit'}...`);

      if (!this.walletClient.account) {
        throw new Error('No account connected');
      }

      const approvalHash = await this.walletClient.writeContract({
        account: this.walletClient.account,
        address: currencyToken as `0x${string}`,
        abi: [
          {
            name: 'approve',
            type: 'function',
            inputs: [
              { name: 'spender', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [{ name: '', type: 'bool' }],
            stateMutability: 'nonpayable',
          },
        ],
        functionName: 'approve',
        args: [approvalTarget as `0x${string}`, priceInSmallestUnit],
      });

      console.log(`${currencyName} approval transaction sent:`, approvalHash);
      await this.publicClient.waitForTransactionReceipt({ hash: approvalHash });
      console.log(`${currencyName} approval confirmed`);
    } else {
      console.log(`${currencyName} already approved for Seaport/conduit`);
    }

    console.log('Creating offer with params:', {
      offerer: offererAddress,
      startTime,
      endTime,
      offer,
      consideration,
      conduitKey,
      marketplace,
    });

    // Create the order using Seaport
    const { executeAllActions } = await this.seaport.createOrder(
      {
        offer,
        consideration: [...consideration, ...additionalRecipients],
        startTime,
        endTime,
        offerer: offererAddress as `0x${string}`,
        zone: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        conduitKey: conduitKey as `0x${string}`,
      },
      offererAddress as `0x${string}`
    );

    // Execute all actions (approval + signing)
    const order = await executeAllActions();

    console.log('Offer created:', {
      hasParameters: !!order.parameters,
      hasSignature: !!order.signature,
      signatureLength: order.signature?.length,
      offerer: order.parameters?.offerer,
      conduitKey: order.parameters?.conduitKey
    });

    return order;
  }
}

// Export singleton instance
export const seaportClient = new SeaportClient();