import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';

const commaSeparatedOriginsSchema = z
  .string()
  .min(1)
  .transform((value, context) => {
    const origins = value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);

    if (origins.includes('*')) {
      context.addIssue({ code: 'custom', message: 'Wildcard CORS origins are not allowed.' });
      return z.NEVER;
    }

    const invalidOrigin = origins.find((origin) => {
      try {
        const url = new URL(origin);
        return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin;
      } catch {
        return true;
      }
    });

    if (invalidOrigin) {
      context.addIssue({ code: 'custom', message: `Invalid CORS origin: ${invalidOrigin}` });
      return z.NEVER;
    }

    return origins;
  });

const mongoUriSchema = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
    'MongoDB URI must use mongodb:// or mongodb+srv://.',
  );

const redisUriSchema = z
  .string()
  .url()
  .refine(
    (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
    'Redis URI must use redis:// or rediss://.',
  );

const featureFlagSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const environmentSchema = z
  .object({
    ACCESS_TOKEN_AUDIENCE: z.string().min(1).max(200),
    ADMIN_EMAILS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean),
      ),
    ACCESS_TOKEN_ISSUER: z.string().min(1).max(200),
    ACCESS_TOKEN_PRIVATE_KEY_BASE64: z.string().min(1),
    ACCESS_TOKEN_PUBLIC_KEY_BASE64: z.string().min(1),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
    BODY_LIMIT: z
      .string()
      .regex(/^\d+(?:b|kb|mb)$/i)
      .default('100kb'),
    CORS_ALLOWED_ORIGINS: commaSeparatedOriginsSchema,
    REGISTRATION_OTP_ENABLED: featureFlagSchema,
    PASSWORD_RESET_ENABLED: featureFlagSchema,
    EMAIL_PROVIDER: z.enum(['unconfigured', 'resend']).default('unconfigured'),
    RESEND_API_KEY: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(20).optional(),
    ),
    RESEND_FROM_EMAIL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().email().optional(),
    ),
    RESEND_FROM_NAME: z.string().min(1).max(100).default('Alap'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(5_000),
    MONGODB_URI: mongoUriSchema,
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4_000),
    REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    REDIS_URL: redisUriSchema,
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(60).default(15),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
    TRUST_PROXY: z.enum(['false', 'loopback']).default('false'),
    FIREBASE_PROJECT_ID: z.string().min(1),
    FIREBASE_CLIENT_EMAIL: z.string().email(),
    FIREBASE_PRIVATE_KEY_BASE64: z
      .string()
      .min(1)
      .superRefine((value, context) => {
        try {
          if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error();
          const pem = Buffer.from(value, 'base64').toString('utf8');
          if (!/^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(pem.trim())) throw new Error();
          if (createPrivateKey(pem).asymmetricKeyType !== 'rsa') throw new Error();
        } catch {
          context.addIssue({ code: 'custom', message: 'Must encode a valid RSA PEM private key.' });
        }
      }),
  })
  .superRefine((value, context) => {
    if (value.REGISTRATION_OTP_ENABLED || value.PASSWORD_RESET_ENABLED) {
      if (value.EMAIL_PROVIDER !== 'resend')
        context.addIssue({
          code: 'custom',
          message:
            'Resend email delivery is required when an email-dependent auth feature is enabled.',
          path: ['EMAIL_PROVIDER'],
        });
      for (const key of ['RESEND_API_KEY', 'RESEND_FROM_EMAIL'] as const) {
        if (!value[key]) {
          context.addIssue({
            code: 'custom',
            message: `${key} is required when EMAIL_PROVIDER=resend.`,
            path: [key],
          });
        }
      }
    }
  });

export type ApiConfig = Readonly<{
  adminEmails: readonly string[];
  registrationOtpEnabled: boolean;
  passwordResetEnabled: boolean;
  accessTokenAudience: string;
  accessTokenIssuer: string;
  accessTokenPrivateKey: string;
  accessTokenPublicKey: string;
  accessTokenTtlSeconds: number;
  bodyLimit: string;
  corsAllowedOrigins: readonly string[];
  email:
    | Readonly<{ provider: 'unconfigured' }>
    | Readonly<{ apiKey: string; fromEmail: string; fromName: string; provider: 'resend' }>;
  logLevel: z.infer<typeof environmentSchema>['LOG_LEVEL'];
  mongoMaxPoolSize: number;
  mongoServerSelectionTimeoutMs: number;
  mongoUri: string;
  nodeEnv: z.infer<typeof environmentSchema>['NODE_ENV'];
  port: number;
  redisConnectTimeoutMs: number;
  redisUrl: string;
  refreshTokenTtlDays: number;
  passwordResetTtlMinutes: number;
  shutdownTimeoutMs: number;
  trustProxy: false | 'loopback';
  firebase: Readonly<{
    projectId: string;
    clientEmail: string;
    privateKey: string;
  }>;
}>;

export class EnvironmentValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid API environment configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'EnvironmentValidationError';
    this.issues = issues;
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'environment';
      return `${path}: ${issue.message}`;
    });

    throw new EnvironmentValidationError(issues);
  }

  let email: ApiConfig['email'];
  if (
    (result.data.REGISTRATION_OTP_ENABLED || result.data.PASSWORD_RESET_ENABLED) &&
    result.data.EMAIL_PROVIDER === 'resend'
  ) {
    email = Object.freeze({
      apiKey: result.data.RESEND_API_KEY!,
      fromEmail: result.data.RESEND_FROM_EMAIL!,
      fromName: result.data.RESEND_FROM_NAME,
      provider: 'resend' as const,
    });
  } else {
    email = Object.freeze({ provider: 'unconfigured' as const });
  }

  return Object.freeze({
    adminEmails: Object.freeze([...result.data.ADMIN_EMAILS]),
    registrationOtpEnabled: result.data.REGISTRATION_OTP_ENABLED,
    passwordResetEnabled: result.data.PASSWORD_RESET_ENABLED,
    accessTokenAudience: result.data.ACCESS_TOKEN_AUDIENCE,
    accessTokenIssuer: result.data.ACCESS_TOKEN_ISSUER,
    accessTokenPrivateKey: Buffer.from(
      result.data.ACCESS_TOKEN_PRIVATE_KEY_BASE64,
      'base64',
    ).toString('utf8'),
    accessTokenPublicKey: Buffer.from(
      result.data.ACCESS_TOKEN_PUBLIC_KEY_BASE64,
      'base64',
    ).toString('utf8'),
    accessTokenTtlSeconds: result.data.ACCESS_TOKEN_TTL_SECONDS,
    bodyLimit: result.data.BODY_LIMIT,
    corsAllowedOrigins: Object.freeze([...result.data.CORS_ALLOWED_ORIGINS]),
    email,
    logLevel: result.data.LOG_LEVEL,
    mongoMaxPoolSize: result.data.MONGODB_MAX_POOL_SIZE,
    mongoServerSelectionTimeoutMs: result.data.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    mongoUri: result.data.MONGODB_URI,
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    redisConnectTimeoutMs: result.data.REDIS_CONNECT_TIMEOUT_MS,
    redisUrl: result.data.REDIS_URL,
    refreshTokenTtlDays: result.data.REFRESH_TOKEN_TTL_DAYS,
    passwordResetTtlMinutes: result.data.PASSWORD_RESET_TTL_MINUTES,
    shutdownTimeoutMs: result.data.SHUTDOWN_TIMEOUT_MS,
    trustProxy: result.data.TRUST_PROXY === 'loopback' ? 'loopback' : false,
    firebase: Object.freeze({
      projectId: result.data.FIREBASE_PROJECT_ID,
      clientEmail: result.data.FIREBASE_CLIENT_EMAIL,
      privateKey: Buffer.from(result.data.FIREBASE_PRIVATE_KEY_BASE64, 'base64').toString('utf8'),
    }),
  });
}
