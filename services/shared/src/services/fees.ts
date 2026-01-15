import { config } from '../config';

export interface FeeConfig {
  enabled: boolean;
  receiverAddress: string;
  basisPoints: number;
}

export interface BrokerFeeConfig {
  minBasisPoints: number;
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

/**
 * Get broker fee configuration from environment/config
 */
export function getBrokerFeeConfig(): BrokerFeeConfig {
  return {
    minBasisPoints: config.broker.minFeeBasisPoints,
  };
}

/**
 * Calculate broker fee amount in wei
 */
export function calculateBrokerFee(priceWei: string, basisPoints: number): bigint {
  const price = BigInt(priceWei);
  return (price * BigInt(basisPoints)) / BigInt(10000);
}

/**
 * Validate broker fee in Seaport order
 * This validation is INDEPENDENT of platform fee settings
 */
export function validateBrokerFeeInOrder(
  orderData: any,
  brokerAddress: string,
  brokerFeeBps: number
): { valid: boolean; error?: string } {
  const brokerConfig = getBrokerFeeConfig();

  // Validate minimum fee (always enforced, independent of platform fee settings)
  if (brokerFeeBps < brokerConfig.minBasisPoints) {
    return {
      valid: false,
      error: `Broker fee must be at least ${brokerConfig.minBasisPoints} basis points (${brokerConfig.minBasisPoints / 100}%)`,
    };
  }

  // Parse order data if it's a string
  const order = typeof orderData === 'string' ? JSON.parse(orderData) : orderData;
  const parameters = order.protocol_data?.parameters || order.parameters;

  if (!parameters || !parameters.consideration) {
    return { valid: false, error: 'Invalid order structure' };
  }

  // Look for the broker fee in the consideration items
  const brokerConsideration = parameters.consideration.find(
    (c: any) => c.recipient?.toLowerCase() === brokerAddress.toLowerCase()
  );

  if (!brokerConsideration) {
    return { valid: false, error: 'Missing broker fee consideration item in order' };
  }

  return { valid: true };
}

/**
 * Validate all fees in order for brokered listings
 * - Platform fee: only validated if FEE_ENABLED=true
 * - Broker fee: always validated (independent of platform fee settings)
 */
export function validateBrokeredListingFees(
  orderData: any,
  brokerAddress: string,
  brokerFeeBps: number
): { valid: boolean; error?: string } {
  const platformConfig = getFeeConfig();

  // Validate platform fee only if enabled
  if (platformConfig.enabled) {
    const platformValidation = validateFeeInOrder(orderData, 'grails');
    if (!platformValidation.valid) {
      return platformValidation;
    }
  }

  // Always validate broker fee (independent of platform fee settings)
  return validateBrokerFeeInOrder(orderData, brokerAddress, brokerFeeBps);
}
