import { z } from 'zod';

export const ENSNameSchema = z.object({
  id: z.number().optional(),
  name: z.string(),
  tokenId: z.string(),
  ownerAddress: z.string(),
  registrant: z.string().optional(),
  expiryDate: z.date().optional(),
  registrationDate: z.date().optional(),
  lastTransferDate: z.date().optional(),
  metadata: z.record(z.any()).optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});

export const ListingSchema = z.object({
  id: z.number().optional(),
  ensNameId: z.number(),
  sellerAddress: z.string(),
  priceWei: z.string(),
  currencyAddress: z.string().optional(),
  orderHash: z.string().optional(),
  orderData: z.record(z.any()),
  status: z.enum(['active', 'sold', 'cancelled', 'expired']),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
  expiresAt: z.date().optional(),
});

export const OfferSchema = z.object({
  id: z.number().optional(),
  ensNameId: z.number(),
  buyerAddress: z.string(),
  offerAmountWei: z.string(),
  currencyAddress: z.string().optional(),
  orderHash: z.string().optional(),
  orderData: z.record(z.any()),
  status: z.enum(['pending', 'accepted', 'rejected', 'expired']),
  createdAt: z.date().optional(),
  expiresAt: z.date().optional(),
});

export const TransactionSchema = z.object({
  id: z.number().optional(),
  ensNameId: z.number(),
  transactionHash: z.string(),
  blockNumber: z.bigint(),
  fromAddress: z.string(),
  toAddress: z.string(),
  priceWei: z.string().optional(),
  transactionType: z.enum(['sale', 'transfer', 'registration', 'renewal']),
  timestamp: z.date(),
  createdAt: z.date().optional(),
});

export const BlockchainEventSchema = z.object({
  id: z.number().optional(),
  blockNumber: z.bigint(),
  transactionHash: z.string(),
  logIndex: z.number(),
  contractAddress: z.string(),
  eventName: z.string(),
  eventData: z.record(z.any()),
  processed: z.boolean().default(false),
  createdAt: z.date().optional(),
});

export type ENSName = z.infer<typeof ENSNameSchema>;
export type Listing = z.infer<typeof ListingSchema>;
export type Offer = z.infer<typeof OfferSchema>;
export type Transaction = z.infer<typeof TransactionSchema>;
export type BlockchainEvent = z.infer<typeof BlockchainEventSchema>;

export enum OrderType {
  FULL_OPEN = 0,
  PARTIAL_OPEN = 1,
  FULL_RESTRICTED = 2,
  PARTIAL_RESTRICTED = 3,
  CONTRACT = 4,
}

export enum ItemType {
  NATIVE = 0,
  ERC20 = 1,
  ERC721 = 2,
  ERC1155 = 3,
  ERC721_WITH_CRITERIA = 4,
  ERC1155_WITH_CRITERIA = 5,
}

export interface SeaportOfferItem {
  itemType: ItemType;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
}

export interface SeaportConsiderationItem extends SeaportOfferItem {
  recipient: string;
}

export interface SeaportOrder {
  offerer: string;
  zone: string;
  offer: SeaportOfferItem[];
  consideration: SeaportConsiderationItem[];
  orderType: OrderType;
  startTime: number;
  endTime: number;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  totalOriginalConsiderationItems: number;
}

export interface IndexerConfig {
  startBlock: number;
  batchSize: number;
  confirmations: number;
  retryAttempts: number;
  reorganizationDepth: number;
}

export interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  meta: {
    timestamp: string;
    version?: string;
    requestId?: string;
  };
}