export interface FeeConfig {
  enabled: boolean;
  receiverAddress: string;
  basisPoints: number;
}

export function getFeeConfig(): FeeConfig {
  return {
    enabled: process.env.FEE_ENABLED === 'true',
    receiverAddress: process.env.FEE_RECEIVER_ADDRESS || '',
    basisPoints: parseInt(process.env.FEE_BASIS_POINTS || '250'),
  };
}

export function calculateFee(priceWei: string, basisPoints: number): bigint {
  const price = BigInt(priceWei);
  return (price * BigInt(basisPoints)) / BigInt(10000);
}

export function validateFeeInOrder(orderData: any, source: string): {
  valid: boolean;
  error?: string;
} {
  const config = getFeeConfig();

  // If fees are disabled or this is not a Grails order, skip validation
  if (!config.enabled || source !== 'grails') {
    return { valid: true };
  }

  // Parse order data if it's a string
  const order = typeof orderData === 'string' ? JSON.parse(orderData) : orderData;
  const parameters = order.protocol_data?.parameters || order.parameters;

  if (!parameters || !parameters.consideration) {
    return { valid: false, error: 'Invalid order structure' };
  }

  // Look for the Grails fee in the consideration items
  const feeConsideration = parameters.consideration.find(
    (c: any) => c.recipient?.toLowerCase() === config.receiverAddress.toLowerCase()
  );

  if (!feeConsideration) {
    return { valid: false, error: 'Missing Grails marketplace fee' };
  }

  return { valid: true };
}
