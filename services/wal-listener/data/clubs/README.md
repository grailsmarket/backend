# Club Data Files

This directory contains data files for managing ENS name clubs.

## Architecture

The clubs system uses a scalable **junction table architecture**:
- `clubs` table: Club metadata (name, description, member_count)
- `club_memberships` table: Source of truth for name-to-club mappings
- `ens_names.clubs` column: Denormalized array auto-synced via triggers
- Elasticsearch: Auto-synced via WAL listener for search

This architecture supports clubs with millions of members efficiently.

## File Format

Supported formats:
- **JSON**: `["name1.eth", "name2.eth", "name3.eth"]`
- **CSV**: One name per line
- **TXT**: One name per line (lines starting with `#` are ignored as comments)

## Example Files

### JSON Format (pokemon.json)
```json
[
  "pikachu.eth",
  "charmander.eth",
  "bulbasaur.eth"
]
```

### CSV/TXT Format (crypto-terms.csv)
```
btc.eth
eth.eth
defi.eth
nft.eth
# This is a comment
dao.eth
```

## CLI Commands

```bash
# Add names to a club (with optional description)
npx tsx src/scripts/manage-clubs.ts add <club-name> <file> [--description "text"]

# Remove names from a club
npx tsx src/scripts/manage-clubs.ts remove <club-name> <file>

# List all clubs with member counts
npx tsx src/scripts/manage-clubs.ts list-clubs

# List all names in a specific club
npx tsx src/scripts/manage-clubs.ts list-names <club-name>

# Remove all names from a club (keeps club metadata)
npx tsx src/scripts/manage-clubs.ts clear <club-name> --confirm

# Permanently delete a club and all memberships
npx tsx src/scripts/manage-clubs.ts delete-club <club-name> --confirm

# Resync Elasticsearch after bulk changes
npx tsx src/scripts/resync-elasticsearch.ts
```

## Adding a New Club

1. Create a data file (JSON, CSV, or TXT) with ENS names
2. Run: `npx tsx src/scripts/manage-clubs.ts add pokemon data/clubs/pokemon.json --description "Pokemon character names"`
3. Resync Elasticsearch: `npx tsx src/scripts/resync-elasticsearch.ts`

## Example Clubs

- **pokemon**: Pokemon character names
- **crypto-terms**: Cryptocurrency and DeFi terminology
- **cities**: Major city names
- **countries**: Country names
- **brands**: Brand names
- **animals**: Animal names
- **colors**: Color names
- **food**: Food and beverage names
