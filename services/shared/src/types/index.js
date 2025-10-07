"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ItemType = exports.OrderType = exports.BlockchainEventSchema = exports.TransactionSchema = exports.OfferSchema = exports.ListingSchema = exports.ENSNameSchema = void 0;
const zod_1 = require("zod");
exports.ENSNameSchema = zod_1.z.object({
    id: zod_1.z.number().optional(),
    name: zod_1.z.string(),
    tokenId: zod_1.z.string(),
    ownerAddress: zod_1.z.string(),
    registrant: zod_1.z.string().optional(),
    expiryDate: zod_1.z.date().optional(),
    registrationDate: zod_1.z.date().optional(),
    lastTransferDate: zod_1.z.date().optional(),
    metadata: zod_1.z.record(zod_1.z.any()).optional(),
    createdAt: zod_1.z.date().optional(),
    updatedAt: zod_1.z.date().optional(),
});
exports.ListingSchema = zod_1.z.object({
    id: zod_1.z.number().optional(),
    ensNameId: zod_1.z.number(),
    sellerAddress: zod_1.z.string(),
    priceWei: zod_1.z.string(),
    currencyAddress: zod_1.z.string().optional(),
    orderHash: zod_1.z.string().optional(),
    orderData: zod_1.z.record(zod_1.z.any()),
    status: zod_1.z.enum(['active', 'sold', 'cancelled', 'expired']),
    createdAt: zod_1.z.date().optional(),
    updatedAt: zod_1.z.date().optional(),
    expiresAt: zod_1.z.date().optional(),
});
exports.OfferSchema = zod_1.z.object({
    id: zod_1.z.number().optional(),
    ensNameId: zod_1.z.number(),
    buyerAddress: zod_1.z.string(),
    offerAmountWei: zod_1.z.string(),
    currencyAddress: zod_1.z.string().optional(),
    orderHash: zod_1.z.string().optional(),
    orderData: zod_1.z.record(zod_1.z.any()),
    status: zod_1.z.enum(['pending', 'accepted', 'rejected', 'expired']),
    createdAt: zod_1.z.date().optional(),
    expiresAt: zod_1.z.date().optional(),
});
exports.TransactionSchema = zod_1.z.object({
    id: zod_1.z.number().optional(),
    ensNameId: zod_1.z.number(),
    transactionHash: zod_1.z.string(),
    blockNumber: zod_1.z.bigint(),
    fromAddress: zod_1.z.string(),
    toAddress: zod_1.z.string(),
    priceWei: zod_1.z.string().optional(),
    transactionType: zod_1.z.enum(['sale', 'transfer', 'registration', 'renewal']),
    timestamp: zod_1.z.date(),
    createdAt: zod_1.z.date().optional(),
});
exports.BlockchainEventSchema = zod_1.z.object({
    id: zod_1.z.number().optional(),
    blockNumber: zod_1.z.bigint(),
    transactionHash: zod_1.z.string(),
    logIndex: zod_1.z.number(),
    contractAddress: zod_1.z.string(),
    eventName: zod_1.z.string(),
    eventData: zod_1.z.record(zod_1.z.any()),
    processed: zod_1.z.boolean().default(false),
    createdAt: zod_1.z.date().optional(),
});
var OrderType;
(function (OrderType) {
    OrderType[OrderType["FULL_OPEN"] = 0] = "FULL_OPEN";
    OrderType[OrderType["PARTIAL_OPEN"] = 1] = "PARTIAL_OPEN";
    OrderType[OrderType["FULL_RESTRICTED"] = 2] = "FULL_RESTRICTED";
    OrderType[OrderType["PARTIAL_RESTRICTED"] = 3] = "PARTIAL_RESTRICTED";
    OrderType[OrderType["CONTRACT"] = 4] = "CONTRACT";
})(OrderType || (exports.OrderType = OrderType = {}));
var ItemType;
(function (ItemType) {
    ItemType[ItemType["NATIVE"] = 0] = "NATIVE";
    ItemType[ItemType["ERC20"] = 1] = "ERC20";
    ItemType[ItemType["ERC721"] = 2] = "ERC721";
    ItemType[ItemType["ERC1155"] = 3] = "ERC1155";
    ItemType[ItemType["ERC721_WITH_CRITERIA"] = 4] = "ERC721_WITH_CRITERIA";
    ItemType[ItemType["ERC1155_WITH_CRITERIA"] = 5] = "ERC1155_WITH_CRITERIA";
})(ItemType || (exports.ItemType = ItemType = {}));
//# sourceMappingURL=index.js.map