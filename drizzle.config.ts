// Placeholder drizzle config for Sprint 0.
// This will be properly configured once drizzle-kit is installed in Sprint 1.
const config = {
  schema: './db/schema/*',
  out: './db/migrations',
  dialect: 'postgresql' as const,
  dbCredentials: {
    url: process.env.DATABASE_URL || '',
  },
};

export default config;
