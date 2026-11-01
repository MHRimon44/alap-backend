import { generateKeyPairSync } from 'node:crypto';
import { EnvironmentValidationError, loadConfig } from '../src/config/env.js';

const validEnvironment: NodeJS.ProcessEnv = {
  FIREBASE_PROJECT_ID: 'test-project',
  FIREBASE_CLIENT_EMAIL: 'test@example.com',
  FIREBASE_PRIVATE_KEY_BASE64: Buffer.from(
    generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey,
  ).toString('base64'),
  ACCESS_TOKEN_AUDIENCE: 'chat-mobile-test',
  ACCESS_TOKEN_ISSUER: 'chat-api-test',
  ACCESS_TOKEN_PRIVATE_KEY_BASE64: Buffer.from('private-key').toString('base64'),
  ACCESS_TOKEN_PUBLIC_KEY_BASE64: Buffer.from('public-key').toString('base64'),
  CORS_ALLOWED_ORIGINS: 'https://app.example,https://admin.example',
  MONGODB_URI: 'mongodb://user:password@localhost:27017/chat_test',
  NODE_ENV: 'test',
  PASSWORD_RESET_URL: 'https://app.example/password/reset',
  REDIS_URL: 'redis://:password@localhost:6379/1',
};

describe('API environment configuration', () => {
  it('parses, normalizes, and freezes valid configuration', () => {
    const config = loadConfig(validEnvironment);

    expect(config.corsAllowedOrigins).toEqual(['https://app.example', 'https://admin.example']);
    expect(config.port).toBe(4_000);
    expect(config.trustProxy).toBe(false);
    expect(config.email).toEqual({ provider: 'unconfigured' });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.corsAllowedOrigins)).toBe(true);
  });

  it('requires a Resend key and sender when enabled', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        REGISTRATION_OTP_ENABLED: 'true',
        EMAIL_PROVIDER: 'resend',
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it('loads a typed Resend email configuration', () => {
    const config = loadConfig({
      ...validEnvironment,
      REGISTRATION_OTP_ENABLED: 'true',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_placeholder_key_123456789',
      RESEND_FROM_EMAIL: 'security@example.com',
      RESEND_FROM_NAME: 'Alap',
    });
    expect(config.email).toEqual({
      provider: 'resend',
      apiKey: 're_test_placeholder_key_123456789',
      fromEmail: 'security@example.com',
      fromName: 'Alap',
    });
  });

  it('rejects unsupported legacy email providers', () => {
    for (const provider of ['ses', 'smtp', 'brevo']) {
      expect(() => loadConfig({ ...validEnvironment, EMAIL_PROVIDER: provider })).toThrow(
        EnvironmentValidationError,
      );
    }
  });

  it('rejects wildcard CORS configuration', () => {
    expect(() => loadConfig({ ...validEnvironment, CORS_ALLOWED_ORIGINS: '*' })).toThrow(
      EnvironmentValidationError,
    );
  });

  it('accepts encrypted production-style provider connection schemes', () => {
    const config = loadConfig({
      ...validEnvironment,
      MONGODB_URI: 'mongodb+srv://user:password@cluster.example/chat',
      REDIS_URL: 'rediss://:password@redis.example:6380/0',
    });

    expect(config.mongoUri).toMatch(/^mongodb\+srv:\/\//);
    expect(config.redisUrl).toMatch(/^rediss:\/\//);
  });

  it('rejects missing required connection configuration without exposing values', () => {
    try {
      loadConfig({ NODE_ENV: 'test' });
      throw new Error('Expected environment validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as EnvironmentValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining('MONGODB_URI'),
          expect.stringContaining('REDIS_URL'),
          expect.stringContaining('CORS_ALLOWED_ORIGINS'),
        ]),
      );
    }
  });
});

describe('temporary auth environment', () => {
  it.each(['development', 'production'])(
    'loads disabled features without unused email credentials in %s',
    (nodeEnv) => {
      const config = loadConfig({
        ...validEnvironment,
        NODE_ENV: nodeEnv,
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: '',
        RESEND_FROM_EMAIL: '',
      });
      expect(config.registrationOtpEnabled).toBe(false);
      expect(config.passwordResetEnabled).toBe(false);
      expect(config.email).toEqual({ provider: 'unconfigured' });
    },
  );

  it.each(['REGISTRATION_OTP_ENABLED', 'PASSWORD_RESET_ENABLED'])(
    'requires working email configuration for %s',
    (flag) => {
      expect(() => loadConfig({ ...validEnvironment, [flag]: 'true' })).toThrow(
        EnvironmentValidationError,
      );
      expect(() =>
        loadConfig({ ...validEnvironment, [flag]: 'true', EMAIL_PROVIDER: 'resend' }),
      ).toThrow(EnvironmentValidationError);
      const config = loadConfig({
        ...validEnvironment,
        [flag]: 'true',
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test_placeholder_key_123456789',
        RESEND_FROM_EMAIL: 'security@example.com',
      });
      expect(config.email.provider).toBe('resend');
    },
  );

  it('rejects ambiguous flag values instead of coercing them to true', () => {
    expect(() => loadConfig({ ...validEnvironment, REGISTRATION_OTP_ENABLED: '0' })).toThrow(
      EnvironmentValidationError,
    );
  });
});

it('rejects malformed Firebase keys without including their value', () => {
  expect(() =>
    loadConfig({ ...validEnvironment, FIREBASE_PRIVATE_KEY_BASE64: 'invalid-secret' }),
  ).toThrow('Must encode a valid RSA PEM private key.');
});
