// The online game server. Runs on Supabase Edge Functions (Deno).
// Players call it with their sign-in token. It is the only holder of the service
// key, and the only code that deals cards or moves online chips.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { GameError, handleRequest } from './core.bundle.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const url = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'bad_request' });

  // Identify the player from their own token. Nothing in the body is trusted for identity.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return json(401, { error: 'not_signed_in' });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'bad_request' });
  }

  try {
    const result = await handleRequest(data.user.id, body, {
      now: () => Date.now(),
      rpc: async (name, args) => {
        const { data: value, error: rpcError } = await admin.rpc(name, args);
        if (rpcError) throw new Error(rpcError.message);
        return value;
      },
    });
    return json(200, result);
  } catch (e) {
    if (e instanceof GameError) return json(e.status, { error: e.code });
    console.error(e);
    return json(500, { error: 'server_error' });
  }
});
