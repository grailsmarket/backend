// ENS Subgraph endpoint
const ENS_SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/ensdomains/ens';

/**
 * Fetch the token ID for an ENS name from the ENS subgraph
 */
export async function fetchENSTokenId(ensName: string): Promise<string | null> {
  // Remove .eth suffix if present and convert to lowercase
  const label = ensName.toLowerCase().replace('.eth', '');

  const query = `
    query GetDomain($label: String!) {
      domains(where: { label: $label }) {
        id
        labelhash
        label {
          id
        }
      }
    }
  `;

  try {
    const response = await fetch(ENS_SUBGRAPH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { label }
      }),
    });

    const data = await response.json();

    if (data?.data?.domains?.[0]) {
      const domain = data.data.domains[0];
      // The labelhash is the token ID in hex format
      // Convert from hex to decimal
      const tokenId = domain.labelhash ? BigInt(domain.labelhash).toString() : null;
      return tokenId;
    }

    // If no domain found with label, try searching by the full name
    const nameQuery = `
      query GetDomainByName($name: String!) {
        domains(where: { name: $name }) {
          id
          labelhash
          name
        }
      }
    `;

    const nameResponse = await fetch(ENS_SUBGRAPH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: nameQuery,
        variables: { name: ensName.toLowerCase() }
      }),
    });

    const nameData = await nameResponse.json();

    if (nameData?.data?.domains?.[0]) {
      const domain = nameData.data.domains[0];
      const tokenId = domain.labelhash ? BigInt(domain.labelhash).toString() : null;
      return tokenId;
    }

    return null;
  } catch (error) {
    console.error('Error fetching ENS token ID:', error);
    return null;
  }
}

/**
 * Validate if a string is a valid ENS name
 */
export function isValidENSName(name: string): boolean {
  // Basic validation - can be expanded
  if (!name) return false;

  // Check if it's a .eth name
  const parts = name.split('.');
  if (parts.length !== 2 || parts[1] !== 'eth') return false;

  // Label must not be empty
  const label = parts[0];
  if (!label || label.length === 0) return false;

  // Label should only contain valid characters (alphanumeric, hyphens)
  const validLabelRegex = /^[a-z0-9-]+$/;
  if (!validLabelRegex.test(label.toLowerCase())) return false;

  return true;
}