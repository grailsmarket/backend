import { NextRequest, NextResponse } from 'next/server';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';
const OPENSEA_API_URL = process.env.OPENSEA_API_URL || 'https://api.opensea.io';
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { listingIds, canceller, orderHashes, onChainCancellation } = body;

    if (!listingIds || !Array.isArray(listingIds) || listingIds.length === 0) {
      return NextResponse.json(
        { error: 'Invalid listing IDs' },
        { status: 400 }
      );
    }

    if (!canceller) {
      return NextResponse.json(
        { error: 'Canceller address is required' },
        { status: 400 }
      );
    }

    // If this is just marking as cancelled after on-chain cancellation, skip fetching
    if (onChainCancellation) {
      const promises = listingIds.map(async (listingId: number) => {
        const response = await fetch(`${API_BASE_URL}/listings/${listingId}`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          console.error(`Failed to cancel listing ${listingId}:`, await response.text());
          return { listingId, success: false };
        }

        return { listingId, success: true };
      });

      const results = await Promise.all(promises);
      const failed = results.filter(r => !r.success);

      if (failed.length > 0) {
        return NextResponse.json(
          { error: 'Some listings failed to update', failed },
          { status: 207 }
        );
      }

      return NextResponse.json({
        message: 'All listings cancelled successfully',
        listingIds,
      });
    }

    // Fetch listing details to get order data for on-chain cancellation
    const listingDetailsPromises = listingIds.map(async (listingId: number) => {
      const response = await fetch(`${API_BASE_URL}/listings/${listingId}`);
      if (response.ok) {
        const data = await response.json();
        return data.data;
      }
      return null;
    });

    const listings = await Promise.all(listingDetailsPromises);

    // Build order components for on-chain cancellation
    const ordersToCancel = listings
      .map((listing, index) => {
        if (!listing) {
          console.error(`Failed to fetch listing ${listingIds[index]}`);
          return null;
        }

        const source = listing.source || 'grails';
        const orderData = typeof listing.order_data === 'string'
          ? JSON.parse(listing.order_data)
          : listing.order_data;

        // Extract parameters from stored order data
        const parameters = orderData.protocol_data?.parameters || orderData.parameters;

        if (!parameters) {
          console.error(`No order parameters found for listing ${listingIds[index]}`);
          return null;
        }

        return {
          listingId: listingIds[index],
          source,
          orderComponents: {
            offerer: parameters.offerer,
            zone: parameters.zone,
            offer: parameters.offer,
            consideration: parameters.consideration,
            orderType: parameters.orderType,
            startTime: parameters.startTime,
            endTime: parameters.endTime,
            zoneHash: parameters.zoneHash,
            salt: parameters.salt,
            conduitKey: parameters.conduitKey,
            counter: parameters.counter,
          }
        };
      })
      .filter(Boolean);

    if (ordersToCancel.length === 0) {
      return NextResponse.json(
        { error: 'No valid orders found to cancel' },
        { status: 400 }
      );
    }

    // Return order data to frontend for on-chain cancellation
    return NextResponse.json({
      requiresOnChainCancellation: true,
      orders: ordersToCancel,
    });
  } catch (error: any) {
    console.error('Error cancelling orders:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to cancel orders' },
      { status: 500 }
    );
  }
}

