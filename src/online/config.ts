/**
 * Public connection settings for the online backend, set at build time from
 * `.env.production` (or `.env.local` for development). The publishable key is
 * designed to be public: Row Level Security, not secrecy, protects the data.
 * The service role key must never appear in frontend code or these files.
 */
export const SUPABASE_URL: string = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
export const SUPABASE_KEY: string = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';
export const GITHUB_SIGN_IN: boolean = import.meta.env.VITE_AUTH_GITHUB === 'true';

export const onlineConfigured = (): boolean => SUPABASE_URL.startsWith('https://') && SUPABASE_KEY.length > 20;

/** Where sign-in and password links return to: this page, whether on GitHub Pages or localhost. */
export const appUrl = (): string => `${window.location.origin}${window.location.pathname}`;
