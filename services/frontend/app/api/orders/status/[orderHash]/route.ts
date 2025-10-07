import { NextRequest, NextResponse } from 'next/server';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderHash: string }> }
) {
  try {
    const { orderHash } = await params;

    if (!orderHash) {
      return NextResponse.json(
        { error: 'Order hash is required' },
        { status: 400 }
      );
    }

    // Get order status from backend
    const response = await fetch(`${API_BASE_URL}/api/v1/orders/${orderHash}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json(
          { error: 'Order not found' },
          { status: 404 }
        );
      }
      const error = await response.text();
      return NextResponse.json(
        { error: `Failed to get order status: ${error}` },
        { status: response.status }
      );
    }

    const order = await response.json();
    return NextResponse.json(order);
  } catch (error: any) {
    console.error('Error getting order status:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to get order status' },
      { status: 500 }
    );
  }
}