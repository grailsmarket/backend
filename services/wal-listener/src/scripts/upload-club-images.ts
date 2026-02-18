#!/usr/bin/env node

/**
 * Upload Club Images to S3
 *
 * One-time migration script that reads club avatar/header images from
 * the frontend public directory and uploads them to S3 object storage,
 * then updates the database with the S3 keys.
 *
 * Usage:
 *   npx tsx src/scripts/upload-club-images.ts [images-dir]
 *
 * Default images-dir: ../../../../app/public/clubs (relative to script)
 *
 * Environment variables required:
 *   DATABASE_URL - PostgreSQL connection string
 *   BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, ENDPOINT - S3 storage config
 */

import path from 'path';
import fs from 'fs';
import { getPostgresPool, uploadFile, isStorageEnabled } from '../../../shared/src';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

async function main() {
  const imagesDir = process.argv[2] || path.resolve(__dirname, '../../../../app/public/clubs');

  console.log('Upload Club Images to S3');
  console.log('========================\n');
  console.log(`Images directory: ${imagesDir}\n`);

  if (!fs.existsSync(imagesDir)) {
    console.error(`Error: Directory not found: ${imagesDir}`);
    process.exit(1);
  }

  if (!isStorageEnabled()) {
    console.error('Error: Storage is not configured. Set BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, and ENDPOINT.');
    process.exit(1);
  }

  const pool = getPostgresPool();

  // Get all clubs from DB
  const clubsResult = await pool.query('SELECT name FROM clubs ORDER BY name');
  const dbClubs = new Set(clubsResult.rows.map((r: { name: string }) => r.name));
  console.log(`Found ${dbClubs.size} clubs in database\n`);

  // Read club directories
  const entries = fs.readdirSync(imagesDir, { withFileTypes: true });
  const clubDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  console.log(`Found ${clubDirs.length} club directories\n`);

  let uploaded = 0;
  let skipped = 0;
  let errors = 0;

  for (const clubName of clubDirs) {
    if (!dbClubs.has(clubName)) {
      console.log(`  SKIP ${clubName} - not in database`);
      skipped++;
      continue;
    }

    const clubDir = path.join(imagesDir, clubName);
    const files = fs.readdirSync(clubDir);

    let avatarKey: string | null = null;
    let headerKey: string | null = null;

    for (const file of files) {
      const lower = file.toLowerCase();
      const ext = path.extname(lower);
      const baseName = path.basename(lower, ext);
      const contentType = MIME_TYPES[ext];

      if (!contentType) continue;

      const isAvatar = baseName === 'avatar';
      const isHeader = baseName === 'header';

      if (!isAvatar && !isHeader) continue;

      const s3Key = `clubs/${clubName}/${file}`;
      const filePath = path.join(clubDir, file);

      try {
        const buffer = fs.readFileSync(filePath);
        await uploadFile(s3Key, buffer, contentType);

        if (isAvatar) avatarKey = s3Key;
        if (isHeader) headerKey = s3Key;

        console.log(`  OK   ${s3Key} (${(buffer.length / 1024).toFixed(1)} KB)`);
        uploaded++;
      } catch (err) {
        console.error(`  ERR  ${s3Key}: ${err}`);
        errors++;
      }
    }

    // Update DB with S3 keys
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (avatarKey !== null) {
      setClauses.push(`avatar_image_key = $${paramIdx++}`);
      params.push(avatarKey);
    }
    if (headerKey !== null) {
      setClauses.push(`header_image_key = $${paramIdx++}`);
      params.push(headerKey);
    }

    if (setClauses.length > 0) {
      params.push(clubName);
      await pool.query(
        `UPDATE clubs SET ${setClauses.join(', ')} WHERE name = $${paramIdx}`,
        params,
      );
    }
  }

  console.log(`\nDone! Uploaded: ${uploaded}, Skipped: ${skipped}, Errors: ${errors}`);
  await pool.end();
  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
