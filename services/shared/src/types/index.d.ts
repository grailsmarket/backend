import { z } from 'zod';
export declare const ENSNameSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodNumber>;
    name: z.ZodString;
    tokenId: z.ZodString;
    ownerAddress: z.ZodString;
    registrant: z.ZodOptional<z.ZodString>;
    expiryDate: z.ZodOptional<z.ZodDate>;
    registrationDate: z.ZodOptional<z.ZodDate>;
    lastTransferDate: z.ZodOptional<z.ZodDate>;
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
    createdAt: z.ZodOptional<z.ZodDate>;
    updatedAt: z.ZodOptional<z.ZodDate>;
}, "strip", z.ZodTypeAny, {
    name: string;
    tokenId: string;
    ownerAddress: string;
    id?: number | undefined;
    registrant?: string | undefined;
    expiryDate?: Date | undefined;
    registrationDate?: Date | undefined;
    lastTransferDate?: Date | undefined;
    metadata?: Record<string, any> | undefined;
    createdAt?: Date | undefined;
    updatedAt?: Date | undefined;
}, {
    name: string;
    tokenId: string;
    ownerAddress: string;
    id?: number | undefined;
    registrant?: string | undefined;
    expiryDate?: Date | undefined;
    registrationDate?: Date | undefined;
    lastTransferDate?: Date | undefined;
    metadata?: Record<string, any> | undefined;
    createdAt?: Date | undefined;
    updatedAt?: Date | undefined;
}>;
export declare const ListingSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodNumber>;
    ensNameId: z.ZodNumber;
    sellerAddress: z.ZodString;
    priceWei: z.ZodString;
    currencyAddress: z.ZodOptional<z.ZodString>;
    orderHash: z.ZodOptional<z.ZodString>;
    orderData: z.ZodRecord<z.ZodString, z.ZodAny>;
    status: z.ZodEnum<["active", "sold", "cancelled", "expired"]>;
    createdAt: z.ZodOptional<z.ZodDate>;
    updatedAt: z.ZodOptional<z.ZodDate>;
    expiresAt: z.ZodOptional<z.ZodDate>;
}, "strip", z.ZodTypeAny, {
    status: "active" | "sold" | "cancelled" | "expired";
    ensNameId: number;
    sellerAddress: string;
    priceWei: string;
    orderData: Record<string, any>;
    id?: number | undefined;
    createdAt?: Date | undefined;
    updatedAt?: Date | undefined;
    currencyAddress?: string | undefined;
    orderHash?: string | undefined;
    expiresAt?: Date | undefined;
}, {
    status: "active" | "sold" | "cancelled" | "expired";
    ensNameId: number;
    sellerAddress: string;
    priceWei: string;
    orderData: Record<string, any>;
    id?: number | undefined;
    createdAt?: Date | undefined;
    updatedAt?: Date | undefined;
    currencyAddress?: string | undefined;
    orderHash?: string | undefined;
    expiresAt?: Date | undefined;
}>;
export declare const OfferSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodNumber>;
    ensNameId: z.ZodNumber;
    buyerAddress: z.ZodString;
    offerAmountWei: z.ZodString;
    currencyAddress: z.ZodOptional<z.ZodString>;
    orderHash: z.ZodOptional<z.ZodString>;
    orderData: z.ZodRecord<z.ZodString, z.ZodAny>;
    status: z.ZodEnum<["pending", "accepted", "rejected", "expired"]>;
    createdAt: z.ZodOptional<z.ZodDate>;
    expiresAt: z.ZodOptional<z.ZodDate>;
}, "strip", z.ZodTypeAny, {
    status: "expired" | "pending" | "accepted" | "rejected";
    ensNameId: number;
    orderData: Record<string, any>;
    buyerAddress: string;
    offerAmountWei: string;
    id?: number | undefined;
    createdAt?: Date | undefined;
    currencyAddress?: string | undefined;
    orderHash?: string | undefined;
    expiresAt?: Date | undefined;
}, {
    status: "expired" | "pending" | "accepted" | "rejected";
    ensNameId: number;
    orderData: Record<string, any>;
    buyerAddress: string;
    offerAmountWei: string;
    id?: number | undefined;
    createdAt?: Date | undefined;
    currencyAddress?: string | undefined;
    orderHash?: string | undefined;
    expiresAt?: Date | undefined;
}>;
export declare const TransactionSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodNumber>;
    ensNameId: z.ZodNumber;
    transactionHash: z.ZodString;
    blockNumber: z.ZodBigInt;
    fromAddress: z.ZodString;
    toAddress: z.ZodString;
    priceWei: z.ZodOptional<z.ZodString>;
    transactionType: z.ZodEnum<["sale", "transfer", "registration", "renewal"]>;
    timestamp: z.ZodDate;
    createdAt: z.ZodOptional<z.ZodDate>;
}, "strip", z.ZodTypeAny, {
    ensNameId: number;
    transactionHash: string;
    blockNumber: bigint;
    fromAddress: string;
    toAddress: string;
    transactionType: "sale" | "transfer" | "registration" | "renewal";
    timestamp: Date;
    id?: number | undefined;
    createdAt?: Date | undefined;
    priceWei?: string | undefined;
}, {
    ensNameId: number;
    transactionHash: string;
    blockNumber: bigint;
    fromAddress: string;
    toAddress: string;
    transactionType: "sale" | "transfer" | "registration" | "renewal";
    timestamp: Date;
    id?: number | undefined;
    createdAt?: Date | undefined;
    priceWei?: string | undefined;
}>;
export declare const BlockchainEventSchema: z.ZodObject<{
    id: z.ZodOptional<z.ZodNumber>;
    blockNumber: z.ZodBigInt;
    transactionHash: z.ZodString;
    logIndex: z.ZodNumber;
    contractAddress: z.ZodString;
    eventName: z.ZodString;
    eventData: z.ZodRecord<z.ZodString, z.ZodAny>;
    processed: z.ZodDefault<z.ZodBoolean>;
    createdAt: z.ZodOptional<z.ZodDate>;
}, "strip", z.ZodTypeAny, {
    transactionHash: string;
    blockNumber: bigint;
    logIndex: number;
    contractAddress: string;
    eventName: string;
    eventData: Record<string, any>;
    processed: boolean;
    id?: number | undefined;
    createdAt?: Date | undefined;
}, {
    transactionHash: string;
    blockNumber: bigint;
    logIndex: number;
    contractAddress: string;
    eventName: string;
    eventData: Record<string, any>;
    id?: number | undefined;
    createdAt?: Date | undefined;
    processed?: boolean | undefined;
}>;
export type ENSName = z.infer<typeof ENSNameSchema>;
export type Listing = z.infer<typeof ListingSchema>;
export type Offer = z.infer<typeof OfferSchema>;
export type Transaction = z.infer<typeof TransactionSchema>;
export type BlockchainEvent = z.infer<typeof BlockchainEventSchema>;
export declare enum OrderType {
    FULL_OPEN = 0,
    PARTIAL_OPEN = 1,
    FULL_RESTRICTED = 2,
    PARTIAL_RESTRICTED = 3,
    CONTRACT = 4
}
export declare enum ItemType {
    NATIVE = 0,
    ERC20 = 1,
    ERC721 = 2,
    ERC1155 = 3,
    ERC721_WITH_CRITERIA = 4,
    ERC1155_WITH_CRITERIA = 5
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
//# sourceMappingURL=index.d.ts.map