import {
  AuthorizationError,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

/** The part of the Worker env the sign-in flow reads. */
export interface AccessEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  /** Issuer of the Access for SaaS OIDC application; its discovery document names the endpoints. */
  ACCESS_ISSUER: string;
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  /** HMAC key for remembered consent, at least 32 characters. */
  CONSENT_SECRET: string;
  /** The one account allowed in, compared with the verified `email` claim. */
  OWNER_EMAIL: string;
}

/** What `completeAuthorization()` stores and every MCP request carries. */
export interface AccessProps {
  [key: string]: unknown;
  email: string;
  sub: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface UpstreamData {
  verifier: string;
}

const discoveries = new Map<string, Promise<Discovery>>();

function escape(value: string): string {
  return value.replaceAll(/[&<>"']/g, (char) => `&#${char.codePointAt(0)};`);
}

function text(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
}

async function discover(issuer: string): Promise<Discovery> {
  let pending = discoveries.get(issuer);
  if (!pending) {
    pending = fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`).then(
      async (response) => {
        if (!response.ok) throw new Error(`Access discovery answered ${response.status}`);
        const document = (await response.json()) as Discovery;
        if (document.issuer !== issuer) throw new Error("Access discovery names another issuer");
        return document;
      },
    );
    // A failed lookup is retried by the next sign-in instead of cached.
    pending.catch(() => discoveries.delete(issuer));
    discoveries.set(issuer, pending);
  }
  return pending;
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
    : "";
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}</style>
<h1>Allow ${name} to use your memory?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

async function redirectToAccess(
  env: AccessEnv,
  request: Request,
  approved: AuthRequest,
  headers?: Headers,
): Promise<Response> {
  const discovery = await discover(env.ACCESS_ISSUER);
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const upstream = await env.OAUTH_PROVIDER.beginUpstream(approved, {
    data: { verifier } satisfies UpstreamData,
    headers,
  });
  const location = new URL(discovery.authorization_endpoint);
  location.search = new URLSearchParams({
    client_id: env.ACCESS_CLIENT_ID,
    redirect_uri: new URL("/callback", request.url).href,
    response_type: "code",
    scope: "openid email profile",
    state: upstream.state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  upstream.headers.set("Location", location.href);
  return new Response(null, { status: 302, headers: upstream.headers });
}

interface DecodedJwt {
  header: { alg?: string; kid?: string };
  claims: Record<string, unknown>;
  signed: Uint8Array;
  signature: Uint8Array<ArrayBuffer>;
}

function decodeJwt(token: string): DecodedJwt {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) throw new Error("id_token is not a JWT");
  const decoder = new TextDecoder();
  return {
    header: JSON.parse(decoder.decode(base64urlDecode(header))) as DecodedJwt["header"],
    claims: JSON.parse(decoder.decode(base64urlDecode(payload))) as Record<string, unknown>,
    signed: new TextEncoder().encode(`${header}.${payload}`),
    signature: base64urlDecode(signature),
  };
}

async function verifySignature(jwksUri: string, jwt: DecodedJwt): Promise<void> {
  if (jwt.header.alg !== "RS256") throw new Error("id_token is not signed with RS256");
  const jwks = (await (await fetch(jwksUri)).json()) as {
    keys: Array<JsonWebKey & { kid?: string }>;
  };
  const jwk = jwks.keys.find((key) => key.kid === jwt.header.kid);
  if (!jwk) throw new Error("id_token is signed with an unknown key");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, jwt.signature, jwt.signed))) {
    throw new Error("id_token signature does not verify");
  }
}

function checkClaims(
  claims: Readonly<Record<string, unknown>>,
  issuer: string,
  clientId: string,
): void {
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer) throw new Error("id_token names another issuer");
  if (!audience.includes(clientId)) throw new Error("id_token is for another client");
  if (typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("id_token has expired");
  }
}

/**
 * Verify an Access `id_token`: RS256 signature from the issuer's keys, issuer, audience and expiry.
 *
 * @param env - Issuer and client the token must name.
 * @param token - The compact JWT from the token endpoint.
 * @returns {Promise<Record<string, unknown>>} The verified claims.
 */
async function verifyIdToken(env: AccessEnv, token: string): Promise<Record<string, unknown>> {
  const discovery = await discover(env.ACCESS_ISSUER);
  const jwt = decodeJwt(token);
  await verifySignature(discovery.jwks_uri, jwt);
  checkClaims(jwt.claims, discovery.issuer, env.ACCESS_CLIENT_ID);
  return jwt.claims;
}

async function callback(request: Request, env: AccessEnv): Promise<Response> {
  const {
    request: original,
    data,
    headers,
  } = await env.OAUTH_PROVIDER.finishUpstream<UpstreamData>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }

  const discovery = await discover(env.ACCESS_ISSUER);
  const exchanged = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: new URL("/callback", request.url).href,
      client_id: env.ACCESS_CLIENT_ID,
      client_secret: env.ACCESS_CLIENT_SECRET,
      code_verifier: data.verifier,
    }),
  });
  if (!exchanged.ok) return text("Access refused the sign-in.", 502);
  const { id_token: idToken } = (await exchanged.json()) as { id_token?: string };
  if (!idToken) return text("Access returned no id_token.", 502);

  const claims = await verifyIdToken(env, idToken);
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (!email || email !== env.OWNER_EMAIL.toLowerCase() || typeof claims.sub !== "string") {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: original,
    userId: claims.sub,
    metadata: {},
    scope: original.scope,
    props: { email, sub: claims.sub } satisfies AccessProps,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

async function authorize(request: Request, env: AccessEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const remember = { secret: env.CONSENT_SECRET };

  if (request.method === "GET") {
    const authRequest = await oauth.parseAuthRequest(request);
    if (await oauth.isConsentRemembered(request, authRequest, remember)) {
      return redirectToAccess(env, request, authRequest);
    }
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    consent.headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(consentPage(details, consent.handle), { headers: consent.headers });
  }

  const form = await request.formData();
  const handle = form.get("handle");
  if (typeof handle !== "string") return text("The consent form has no handle.", 400);
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { remember });
  return redirectToAccess(env, request, approved.request, approved.headers);
}

const routes: Record<string, (request: Request, env: AccessEnv) => Promise<Response>> = {
  "GET /authorize": authorize,
  "POST /authorize": authorize,
  "GET /callback": callback,
};

/**
 * Everything outside `/mcp`: the authorize page and the Access callback.
 *
 * The Worker is an OAuth server to MCP clients and an OAuth client to Access.
 * Consent is asked per MCP client before Access is involved, because a signed-in
 * Access session would otherwise hand a code to any client that registered itself.
 */
export const accessHandler = {
  async fetch(request: Request, env: AccessEnv): Promise<Response> {
    const route = routes[`${request.method} ${new URL(request.url).pathname}`];
    if (!route) return text("Not found", 404);
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) {
        return Response.redirect(error.redirectTo, 302);
      }
      if (error instanceof AuthorizationError) return text(error.description, 400);
      throw error;
    }
  },
};
