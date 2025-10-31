import { getPostgresPool } from '../../../shared/src';

const pool = getPostgresPool();

export interface CreateSaleParams {
  ensNameId: number;
  sellerAddress: string;
  buyerAddress: string;
  salePriceWei: string;
  currencyAddress?: string;
  listingId?: number;
  offerId?: number;
  transactionHash: string;
  blockNumber: number;
  orderHash?: string;
  orderData?: any;
  source: string;
  platformFeeWei?: string;
  creatorFeeWei?: string;
  metadata?: any;
  saleDate: Date;
}

export async function createSale(params: CreateSaleParams) {
  const {
    ensNameId,
    sellerAddress,
    buyerAddress,
    salePriceWei,
    currencyAddress = '0x0000000000000000000000000000000000000000',
    listingId,
    offerId,
    transactionHash,
    blockNumber,
    orderHash,
    orderData,
    source,
    platformFeeWei,
    creatorFeeWei,
    metadata,
    saleDate
  } = params;

  const query = `
    INSERT INTO sales (
      ens_name_id,
      seller_address,
      buyer_address,
      sale_price_wei,
      currency_address,
      listing_id,
      offer_id,
      transaction_hash,
      block_number,
      order_hash,
      order_data,
      source,
      platform_fee_wei,
      creator_fee_wei,
      metadata,
      sale_date
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (transaction_hash, ens_name_id) DO NOTHING
    RETURNING *
  `;

  const values = [
    ensNameId,
    sellerAddress.toLowerCase(),
    buyerAddress.toLowerCase(),
    salePriceWei,
    currencyAddress,
    listingId,
    offerId,
    transactionHash,
    blockNumber,
    orderHash,
    orderData ? JSON.stringify(orderData) : null,
    source,
    platformFeeWei,
    creatorFeeWei,
    metadata ? JSON.stringify(metadata) : null,
    saleDate
  ];

  const result = await pool.query(query, values);
  const sale = result.rows[0];

  // Return sale with clubs information for caller to handle queue publishing
  if (sale) {
    try {
      // Get clubs for this ENS name to return with sale
      const clubsResult = await pool.query(
        'SELECT clubs FROM ens_names WHERE id = $1',
        [ensNameId]
      );
      const clubs = clubsResult.rows[0]?.clubs || [];

      // Attach clubs to sale object for caller
      return { ...sale, clubs };
    } catch (error) {
      console.error('Failed to fetch clubs for sale:', error);
      return sale;
    }
  }

  return sale;
}

export async function getSalesByName(ensName: string, limit = 20, offset = 0) {
  const dataQuery = `
    SELECT s.*, en.name, en.token_id
    FROM sales s
    JOIN ens_names en ON s.ens_name_id = en.id
    WHERE en.name = $1
    ORDER BY s.sale_date DESC
    LIMIT $2 OFFSET $3
  `;

  const countQuery = `
    SELECT COUNT(*) as count
    FROM sales s
    JOIN ens_names en ON s.ens_name_id = en.id
    WHERE en.name = $1
  `;

  const [dataResult, countResult] = await Promise.all([
    pool.query(dataQuery, [ensName, limit, offset]),
    pool.query(countQuery, [ensName])
  ]);

  return {
    results: dataResult.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

export async function getSalesByAddress(
  address: string,
  type: 'buyer' | 'seller' | 'both' = 'both',
  limit = 20,
  offset = 0
) {
  let whereClause = '';
  if (type === 'buyer') {
    whereClause = 's.buyer_address = $1';
  } else if (type === 'seller') {
    whereClause = 's.seller_address = $1';
  } else {
    whereClause = '(s.buyer_address = $1 OR s.seller_address = $1)';
  }

  const dataQuery = `
    SELECT s.*, en.name, en.token_id
    FROM sales s
    JOIN ens_names en ON s.ens_name_id = en.id
    WHERE ${whereClause}
    ORDER BY s.sale_date DESC
    LIMIT $2 OFFSET $3
  `;

  const countQuery = `
    SELECT COUNT(*) as count
    FROM sales s
    JOIN ens_names en ON s.ens_name_id = en.id
    WHERE ${whereClause}
  `;

  const [dataResult, countResult] = await Promise.all([
    pool.query(dataQuery, [address.toLowerCase(), limit, offset]),
    pool.query(countQuery, [address.toLowerCase()])
  ]);

  return {
    results: dataResult.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

export async function getRecentSales(limit = 20, offset = 0) {
  const dataQuery = `
    SELECT s.*, en.name, en.token_id
    FROM sales s
    JOIN ens_names en ON s.ens_name_id = en.id
    ORDER BY s.sale_date DESC
    LIMIT $1 OFFSET $2
  `;

  const countQuery = `
    SELECT COUNT(*) as count
    FROM sales s
  `;

  const [dataResult, countResult] = await Promise.all([
    pool.query(dataQuery, [limit, offset]),
    pool.query(countQuery)
  ]);

  return {
    results: dataResult.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

export async function getSalesAnalytics(ensNameId: number) {
  const query = `
    SELECT
      COUNT(*) as total_sales,
      AVG(CAST(sale_price_wei AS NUMERIC)) as avg_price_wei,
      MIN(CAST(sale_price_wei AS NUMERIC)) as min_price_wei,
      MAX(CAST(sale_price_wei AS NUMERIC)) as max_price_wei,
      MIN(sale_date) as first_sale_date,
      MAX(sale_date) as last_sale_date
    FROM sales
    WHERE ens_name_id = $1
  `;

  const result = await pool.query(query, [ensNameId]);
  return result.rows[0];
}
