import { NextRequest, NextResponse } from 'next/server';
import { WETH_ADDRESS, USDC_ADDRESS, TOKEN_DECIMALS } from '@/lib/constants';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';
const OPENSEA_API_URL = process.env.OPENSEA_API_URL || 'https://api.opensea.io';
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate required fields based on order type
    const { type, order_data, tokenId, ensNameId, price, currency } = body;

    if (!type || !order_data) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Normalize addresses to lowercase for consistent database storage
    const normalizeAddress = (addr: string | null | undefined) =>
      addr ? addr.toLowerCase() : null;

    const sellerAddress = normalizeAddress(body.seller_address);
    const buyerAddress = normalizeAddress(body.buyer_address);

    // Determine marketplace from order_data metadata
    const marketplace = order_data.marketplace || 'grails';

    // Determine currency address and decimals
    let currencyAddress = ZERO_ADDRESS; // Default to native ETH
    let decimals = TOKEN_DECIMALS.ETH;

    if (currency === 'USDC') {
      currencyAddress = USDC_ADDRESS;
      decimals = TOKEN_DECIMALS.USDC;
    } else if (currency === 'ETH') {
      currencyAddress = ZERO_ADDRESS;
      decimals = TOKEN_DECIMALS.ETH;
    }

    // Calculate price_wei with correct decimals
    const priceInSmallestUnit = price
      ? (BigInt(Math.floor(parseFloat(price) * Math.pow(10, decimals)))).toString()
      : '0';

    // If posting to OpenSea, submit the order to OpenSea API first
    let openSeaSubmissionError = null;
    if ((marketplace === 'opensea' || marketplace === 'both') && type === 'listing') {
      try {
        await submitOrderToOpenSea(order_data);
        console.log('Successfully submitted order to OpenSea');
      } catch (openSeaError: any) {
        console.error('Failed to submit to OpenSea:', openSeaError);
        openSeaSubmissionError = openSeaError.message || String(openSeaError);

        // If listing ONLY to OpenSea, fail the request
        if (marketplace === 'opensea') {
          return NextResponse.json(
            {
              error: `Failed to submit listing to OpenSea: ${openSeaSubmissionError}`,
              details: 'Please check that your wallet owns this NFT and that the order parameters are correct.'
            },
            { status: 500 }
          );
        }
        // For "both", we'll continue and save to our DB, but include warning in response
      }
    }

    // Forward to backend API
    const response = await fetch(`${API_BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type,
        token_id: tokenId,
        ensNameId: ensNameId,
        price_wei: priceInSmallestUnit,
        currency_address: currencyAddress.toLowerCase(),
        order_data: JSON.stringify(order_data),
        order_hash: order_data.orderHash,
        seller_address: type === 'listing' ? sellerAddress : null,
        buyer_address: type === 'offer' || type === 'collection_offer' ? buyerAddress : null,
        traits: body.traits,
        status: 'active',
        source: marketplace, // Track where the order is listed
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return NextResponse.json(
        { error: `Failed to save order: ${error}` },
        { status: response.status }
      );
    }

    const result = await response.json();

    // If there was an OpenSea error during cross-listing, include it in response
    if (openSeaSubmissionError && marketplace === 'both') {
      return NextResponse.json({
        ...result,
        warning: `Listing saved to Grails marketplace, but failed to submit to OpenSea: ${openSeaSubmissionError}`,
      });
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Error creating order:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to create order' },
      { status: 500 }
    );
  }
}

/**
 * Submit a Seaport order to OpenSea's API
 */
async function submitOrderToOpenSea(order_data: any) {
  if (!OPENSEA_API_KEY) {
    throw new Error('OPENSEA_API_KEY not configured');
  }

  const { parameters, signature, protocol_data } = order_data;

  // Use protocol_data if available, otherwise use top-level parameters
  const orderParameters = protocol_data?.parameters || parameters;
  const orderSignature = protocol_data?.signature || signature;

  if (!orderParameters || !orderSignature) {
    throw new Error('Missing order parameters or signature');
  }

  // Build the OpenSea API payload
  // OpenSea expects a specific format for Seaport orders
  const payload = {
    parameters: {
      offerer: orderParameters.offerer,
      zone: orderParameters.zone,
      offer: orderParameters.offer,
      consideration: orderParameters.consideration,
      orderType: orderParameters.orderType,
      startTime: orderParameters.startTime?.toString(),
      endTime: orderParameters.endTime?.toString(),
      zoneHash: orderParameters.zoneHash,
      salt: orderParameters.salt?.toString(),
      conduitKey: orderParameters.conduitKey,
      totalOriginalConsiderationItems: orderParameters.totalOriginalConsiderationItems?.toString(),
      counter: orderParameters.counter?.toString(),
    },
    signature: orderSignature,
    protocol_address: process.env.NEXT_PUBLIC_SEAPORT_ADDRESS || '0x0000000000000068F116a894984e2DB1123eB395',
  };

  const url = `${OPENSEA_API_URL}/v2/orders/ethereum/seaport/listings`;
  console.log('Submitting order to OpenSea:', {
    url,
    offerer: payload.parameters.offerer,
    offerTokenId: payload.parameters.offer?.[0]?.identifierOrCriteria,
    considerationLength: payload.parameters.consideration?.length,
    hasSignature: !!payload.signature,
  });
  console.log('Full OpenSea payload:', JSON.stringify(payload, null, 2));

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': OPENSEA_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('OpenSea API error response:', {
      status: response.status,
      statusText: response.statusText,
      error: errorText,
    });

    // Try to parse error as JSON for better error message
    let errorMessage = errorText;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.message || errorJson.error || errorText;
    } catch (e) {
      // Use raw error text if not JSON
    }

    throw new Error(`OpenSea API error (${response.status}): ${errorMessage}`);
  }

  const result = await response.json();
  console.log('OpenSea API response:', result);
  return result;
}