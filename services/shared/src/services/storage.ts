import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config';

let s3Client: S3Client | null = null;

function getClient(): S3Client {
  if (!s3Client) {
    if (!config.storage.enabled) {
      throw new Error('Storage is not configured');
    }
    s3Client = new S3Client({
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      credentials: {
        accessKeyId: config.storage.accessKeyId!,
        secretAccessKey: config.storage.secretAccessKey!,
      },
      forcePathStyle: config.storage.forcePathStyle,
    });
  }
  return s3Client;
}

export function isStorageEnabled(): boolean {
  return config.storage.enabled;
}

export async function getFile(key: string): Promise<{ body: Buffer; contentType: string } | null> {
  try {
    const response = await getClient().send(new GetObjectCommand({
      Bucket: config.storage.bucket,
      Key: key,
    }));

    const body = await response.Body?.transformToByteArray();
    if (!body) return null;

    return {
      body: Buffer.from(body),
      contentType: response.ContentType || 'application/octet-stream',
    };
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function uploadFile(key: string, buffer: Buffer, contentType: string): Promise<string> {
  await getClient().send(new PutObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return key;
}

export async function deleteFile(key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({
    Bucket: config.storage.bucket,
    Key: key,
  }));
}
