import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { logger } from './logger';

export class S3Service {
  private client: S3Client;
  private bucket: string;
  private publicUrlPrefix: string;

  constructor() {
    const endpoint = process.env.S3_ENDPOINT_URL!;
    const region = process.env.S3_REGION || 'auto';
    const accessKeyId = process.env.S3_ACCESS_KEY_ID!;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY!;
    this.bucket = process.env.S3_BUCKET_NAME!;
    this.publicUrlPrefix = process.env.S3_PUBLIC_URL_PREFIX || `${endpoint}/${this.bucket}`;

    this.client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
  }

  async uploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    });

    await this.client.send(command);
    logger.info(`Uploaded to S3: ${key}`);
    return this.getPublicUrl(key);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return true;
    } catch {
      return false;
    }
  }

  getPublicUrl(key: string): string {
    return `${this.publicUrlPrefix}/${key}`;
  }
}
