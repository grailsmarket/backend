export interface SeaportOrderParameters {
  offerer: `0x${string}`;
  zone: `0x${string}`;
  offer: OfferItem[];
  consideration: ConsiderationItem[];
  orderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: `0x${string}`;
  salt: `0x${string}`;
  conduitKey: `0x${string}`;
  totalOriginalConsiderationItems: number;
}

export interface OfferItem {
  itemType: number;
  token: `0x${string}`;
  identifierOrCriteria: bigint;
  startAmount: bigint;
  endAmount: bigint;
}

export interface ConsiderationItem extends OfferItem {
  recipient: `0x${string}`;
}

export interface SeaportOrder {
  parameters: SeaportOrderParameters;
  signature: `0x${string}`;
}

export interface FulfillmentComponent {
  orderIndex: number;
  itemIndex: number;
}

export interface Fulfillment {
  offerComponents: FulfillmentComponent[];
  considerationComponents: FulfillmentComponent[];
}

export interface AdvancedOrder {
  parameters: SeaportOrderParameters;
  signature: `0x${string}`;
  numerator: bigint;
  denominator: bigint;
  extraData: `0x${string}`;
}

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