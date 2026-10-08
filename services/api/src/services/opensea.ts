import { config } from '../../../shared/src';

const OPENSEA_API_KEY = config.opensea.apiKey || '';
const OPENSEA_API_BASE = config.opensea.apiBaseUrl;
const ENS_CONTRACT_ADDRESS = config.blockchain.ensRegistrarAddress;

export interface OpenSeaListing {
  price: {
    current: {
      value: string;
      currency: string;
    };
  };
  protocol_data: any;
  order_hash: string;
  maker: {
    address: string;
  };
}

export interface OpenSeaOffer {
  price: {
    value: string;
    currency: string;
  };
  protocol_data: any;
  order_hash: string;
  maker: {
    address: string;
  };
}

export async function getBestListingForNFT(tokenId: string): Promise<OpenSeaListing | null> {
  if (!config.opensea.enabled) return null;
  try {
    const response = await fetch(
      `${OPENSEA_API_BASE}/listings/collection/${ENS_CONTRACT_ADDRESS}/nfts/${tokenId}/best`,
      {
        headers: {
          'X-API-KEY': OPENSEA_API_KEY,
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null; // No listing found
      }
      console.error('OpenSea API error:', response.status, await response.text());
      return null;
    }

    const data: any = await response.json();
    return data?.listing || null;
  } catch (error) {
    console.error('Error fetching OpenSea listing:', error);
    return null;
  }
}

export async function getBestOfferForNFT(tokenId: string): Promise<OpenSeaOffer | null> {
  if (!config.opensea.enabled) return null;
  try {
    const response = await fetch(
      `${OPENSEA_API_BASE}/offers/collection/${ENS_CONTRACT_ADDRESS}/nfts/${tokenId}/best`,
      {
        headers: {
          'X-API-KEY': OPENSEA_API_KEY,
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null; // No offer found
      }
      console.error('OpenSea API error:', response.status, await response.text());
      return null;
    }

    const data: any = await response.json();
    return data?.offer || null;
  } catch (error) {
    console.error('Error fetching OpenSea offer:', error);
    return null;
  }
}
