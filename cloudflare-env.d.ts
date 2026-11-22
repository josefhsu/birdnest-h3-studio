declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    COLAB_OAUTH_CONFIG?: string;
    COLAB_ENCRYPTION_KEY?: string;
    CREATOR_SHARED_PASSWORD?: string;
    CREATOR_USERNAME?: string;
    ADMIN_GOOGLE_EMAIL?: string;
    TRUST_SITES_IDENTITY?: string;
  }
}
