import { getCoderByCoinType, coinTypeToNameMap } from '@ensdomains/address-encoder';

// SLIP-44 MSB constant for EVM chain coinTypes (ENSIP-11)
const SLIP44_MSB = 0x80000000;

export interface AddressRecord {
  coinType: number;
  chainId?: number;
  chainName: string;
  address: string;
}

/**
 * Decode a raw address record from the ENS subgraph into a structured format.
 *
 * @param coinType - The coin type (can be a string from GraphQL BigInt)
 * @param rawAddr - The raw address bytes as hex string (e.g., "0x1234...")
 * @returns AddressRecord or null if decoding fails
 */
export function decodeAddressRecord(coinType: string | number, rawAddr: string): AddressRecord | null {
  try {
    const coinTypeNum = typeof coinType === 'string' ? parseInt(coinType, 10) : coinType;

    // Skip the "Default" EVM address (coinType 0x80000000 / 2147483648)
    // This is a generic fallback that typically duplicates the Ethereum address
    // and shows confusingly as chainId: 0, chainName: "Default"
    if (coinTypeNum === SLIP44_MSB) {
      return null;
    }

    // Skip if addr is empty/null
    if (!rawAddr || rawAddr === '0x' || rawAddr === '0x0') {
      return null;
    }

    // Convert hex string to Uint8Array
    const hexWithoutPrefix = rawAddr.startsWith('0x') ? rawAddr.slice(2) : rawAddr;
    if (hexWithoutPrefix.length === 0) {
      return null;
    }

    const bytes = new Uint8Array(hexWithoutPrefix.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hexWithoutPrefix.slice(i * 2, i * 2 + 2), 16);
    }

    // Get the coder for this coin type
    const coder = getCoderByCoinType(coinTypeNum);

    // Encode bytes to address string
    const address = coder.encode(bytes);

    // Determine chain info based on coin type
    let chainId: number | undefined;
    let chainName: string;

    // Check if it's an EVM chain (ENSIP-11: coinType >= 0x80000000)
    if (coinTypeNum >= SLIP44_MSB) {
      chainId = coinTypeNum - SLIP44_MSB;
      // Try to get the name from the known map, otherwise use "Unknown Chain"
      const knownName = coinTypeToNameMap[coinTypeNum.toString() as keyof typeof coinTypeToNameMap];
      chainName = knownName ? knownName[1] : `EVM Chain ${chainId}`;
    } else {
      // SLIP-44 non-EVM chain
      const knownName = coinTypeToNameMap[coinTypeNum.toString() as keyof typeof coinTypeToNameMap];
      chainName = knownName ? knownName[1] : `Unknown (${coinTypeNum})`;
    }

    return {
      coinType: coinTypeNum,
      ...(chainId !== undefined && { chainId }),
      chainName,
      address,
    };
  } catch (error) {
    // Silently fail for decode errors - this is expected for unsupported coin types
    return null;
  }
}

/**
 * Process multiple address records from the ENS subgraph multicoinAddrChangeds field.
 *
 * @param multicoinAddrChangeds - Array of { coinType, addr } from the subgraph
 * @returns Array of decoded AddressRecord objects
 */
export function processAddressRecords(
  multicoinAddrChangeds: Array<{ coinType: string; addr: string }> | null | undefined
): AddressRecord[] {
  if (!multicoinAddrChangeds || !Array.isArray(multicoinAddrChangeds)) {
    return [];
  }

  const records: AddressRecord[] = [];
  // Use a map to keep only the latest value for each coinType
  // (multicoinAddrChangeds contains historical changes in order)
  // If a record's most recent addr is null/empty, it means the user unset it
  const latestByCoinType = new Map<string, { coinType: string; addr: string } | null>();

  for (const record of multicoinAddrChangeds) {
    if (record.coinType) {
      if (record.addr && record.addr !== '0x' && record.addr !== '0x0') {
        latestByCoinType.set(record.coinType, record);
      } else {
        // Address is null/empty - record was unset, mark it as deleted
        latestByCoinType.set(record.coinType, null);
      }
    }
  }

  for (const record of latestByCoinType.values()) {
    if (record) {
      const decoded = decodeAddressRecord(record.coinType, record.addr);
      if (decoded) {
        records.push(decoded);
      }
    }
  }

  // Sort by coinType for consistent ordering
  records.sort((a, b) => a.coinType - b.coinType);

  return records;
}
