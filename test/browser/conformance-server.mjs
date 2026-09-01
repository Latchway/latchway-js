import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const applicationOrigin = "http://127.0.0.1:4173";
const gatewayOrigin = "http://127.0.0.1:4174";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const applicationRoot = resolve(repositoryRoot, ".artifacts/browser-app");
const plainESMRoot = resolve(repositoryRoot, "test/browser/plain-esm");
const distributionRoot = resolve(repositoryRoot, "dist");
const requestID = "req_browser_conformance_0001";
const allowedRequestHeaders = new Set([
  "authorization",
  "content-type",
  "dpop",
  "x-latchway-feature",
  "x-latchway-framework",
  "x-latchway-framework-version",
  "x-latchway-protocol-version",
  "x-latchway-sdk",
  "x-latchway-sdk-version",
]);
const forbiddenProviderHeaders = new Set([
  "api-key",
  "apikey",
  "anthropic-api-key",
  "cookie",
  "openai-api-key",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);
const problemPolicies = {
  attestation_stale: { status: 401, title: "Attestation stale", retryable: false },
  component_revoked: { status: 403, title: "Component revoked", retryable: false },
  dpop_invalid: { status: 401, title: "DPoP proof invalid", retryable: false },
  session_expired: { status: 401, title: "Session expired", retryable: true },
};

let state = createState();

const applicationServer = createServer((request, response) => {
  void serveApplication(request, response);
});
const gatewayServer = createServer((request, response) => {
  void serveGateway(request, response);
});

await Promise.all([
  listen(applicationServer, 4173),
  listen(gatewayServer, 4174),
]);
process.stdout.write(`Latchway browser conformance ready at ${applicationOrigin}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void Promise.all([close(applicationServer), close(gatewayServer)]).finally(() => {
      process.exit(0);
    });
  });
}

function createState() {
  return {
    mode: {
      componentRevokedOnce: false,
      denyOrigin: false,
      redirectChallenge: false,
      refreshProblemOnce: null,
      sessionExpiredOnce: false,
    },
    counters: {
      challenges: 0,
      exchanges: 0,
      refreshes: 0,
      protected: 0,
      revocations: 0,
      preflights: 0,
      redirectTargets: 0,
      streamChunks: 0,
      streamCancellations: 0,
      providerCredentialHeaderViolations: 0,
    },
    currentRefreshes: 0,
    maximumConcurrentRefreshes: 0,
    challengeJkts: [],
    preflightHeaders: [],
    proofIDs: new Set(),
    challenges: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    tokenCounter: 0,
  };
}

async function serveApplication(request, response) {
  const url = new URL(request.url ?? "/", applicationOrigin);
  if (url.pathname === "/__health") {
    writeText(response, 200, "ready");
    return;
  }

  let root = applicationRoot;
  let path = url.pathname;
  if (path === "/plain-esm" || path.startsWith("/plain-esm/")) {
    root = plainESMRoot;
    path = path === "/plain-esm" || path === "/plain-esm/"
      ? "/index.html"
      : path.slice("/plain-esm".length);
  } else if (path.startsWith("/sdk/")) {
    root = distributionRoot;
    path = path.slice("/sdk".length);
  } else if (path === "/") {
    path = "/index.html";
  }

  const target = safeFile(root, path);
  if (target === undefined) {
    writeText(response, 404, "not found");
    return;
  }
  try {
    const content = await readFile(target);
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": strictCSP(),
      "Content-Type": contentType(target),
      "Cross-Origin-Opener-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch {
    writeText(response, 404, "not found");
  }
}

async function serveGateway(request, response) {
  const url = new URL(request.url ?? "/", gatewayOrigin);
  if (url.pathname.startsWith("/__control/")) {
    await serveControl(request, response, url);
    return;
  }

  const origin = request.headers.origin;
  if (request.method === "OPTIONS") {
    state.counters.preflights += 1;
    const headers = commaSeparated(request.headers["access-control-request-headers"]);
    state.preflightHeaders.push(headers);
    if (state.mode.denyOrigin || origin !== applicationOrigin ||
        headers.some((header) => !allowedRequestHeaders.has(header))) {
      writeText(response, 403, "origin rejected");
      return;
    }
    response.writeHead(204, corsHeaders(origin, {
      "Access-Control-Allow-Headers": [...allowedRequestHeaders].join(", "),
      "Access-Control-Allow-Methods": "DELETE, GET, OPTIONS, POST",
      "Access-Control-Max-Age": "0",
    }));
    response.end();
    return;
  }
  if (state.mode.denyOrigin || origin !== applicationOrigin) {
    writeText(response, 403, "origin rejected");
    return;
  }

  for (const name of forbiddenProviderHeaders) {
    if (request.headers[name] !== undefined) state.counters.providerCredentialHeaderViolations += 1;
  }

  try {
    await dispatchGateway(request, response, url, origin);
  } catch {
    writeProblem(response, origin, "dpop_invalid", "The browser conformance server rejected the proof.");
  }
}

async function dispatchGateway(request, response, url, origin) {
  if (url.pathname === "/redirect-target") {
    state.counters.redirectTargets += 1;
    writeJSON(response, origin, 200, { reached: true });
    return;
  }
  if (url.pathname === "/client/v1/session-challenges" && request.method === "POST") {
    if (state.mode.redirectChallenge) {
      response.writeHead(307, corsHeaders(origin, { Location: `${gatewayOrigin}/redirect-target` }));
      response.end();
      return;
    }
    const proof = await verifyDPoP(request, url);
    const body = await readJSON(request);
    if (!isRecord(body) || body.application_id !== "app_01J00000000000000000000000" ||
        body.environment !== "development" || body.platform !== "web" ||
        typeof body.identity_token !== "string" || body.identity_token.length < 16) {
      throw new Error("invalid challenge body");
    }
    state.counters.challenges += 1;
    state.challengeJkts.push(proof.jkt);
    const challengeID = `chl_${String(state.counters.challenges).padStart(20, "a")}`;
    state.challenges.set(challengeID, proof.jkt);
    const now = Date.now();
    writeJSON(response, origin, 201, {
      challenge_id: challengeID,
      challenge_nonce: "b".repeat(43),
      binding_version: 1,
      issued_at: Math.floor(now / 1_000),
      expires_at: new Date(now + 300_000).toISOString(),
      attestation: {
        provider: "debug",
        mode: "required",
        client_data_hash: "c".repeat(43),
      },
    });
    return;
  }
  if (url.pathname === "/client/v1/sessions" && request.method === "POST") {
    const proof = await verifyDPoP(request, url);
    const body = await readJSON(request);
    const challengeID = isRecord(body) && typeof body.challenge_id === "string" ? body.challenge_id : "";
    const expectedJkt = state.challenges.get(challengeID);
    const attestation = isRecord(body) && isRecord(body.attestation) ? body.attestation : undefined;
    const evidence = attestation !== undefined && isRecord(attestation.evidence) ? attestation.evidence : undefined;
    if (expectedJkt !== proof.jkt || attestation?.provider !== "debug" ||
        evidence?.client_data_hash !== "c".repeat(43) ||
        evidence?.challenge_token !== `test-only-${challengeID}`) {
      throw new Error("invalid exchange body");
    }
    state.challenges.delete(challengeID);
    state.counters.exchanges += 1;
    writeJSON(response, origin, 201, issueGrant(proof.jkt));
    return;
  }
  if (url.pathname === "/client/v1/sessions/refresh" && request.method === "POST") {
    const proof = await verifyDPoP(request, url);
    const body = await readJSON(request);
    const refreshToken = isRecord(body) && typeof body.refresh_token === "string" ? body.refresh_token : "";
    const record = state.refreshTokens.get(refreshToken);
    if (record === undefined || record.jkt !== proof.jkt || record.used) throw new Error("invalid refresh token");
    state.counters.refreshes += 1;
    state.currentRefreshes += 1;
    state.maximumConcurrentRefreshes = Math.max(state.maximumConcurrentRefreshes, state.currentRefreshes);
    try {
      await delay(150);
      const problem = state.mode.refreshProblemOnce;
      if (problem !== null) {
        state.mode.refreshProblemOnce = null;
        writeProblem(response, origin, problem, "Fresh browser trust evidence is required.");
        return;
      }
      record.used = true;
      writeJSON(response, origin, 200, issueGrant(proof.jkt));
    } finally {
      state.currentRefreshes -= 1;
    }
    return;
  }

  const authorization = await authorizeAccess(request, url);
  if (authorization === undefined) throw new Error("missing authorization");
  state.counters.protected += 1;
  if (state.mode.sessionExpiredOnce) {
    state.mode.sessionExpiredOnce = false;
    writeProblem(response, origin, "session_expired", "The browser session expired before dispatch.");
    return;
  }
  if (state.mode.componentRevokedOnce) {
    state.mode.componentRevokedOnce = false;
    writeProblem(response, origin, "component_revoked", "The browser component was revoked before dispatch.");
    return;
  }

  if (url.pathname === "/client/v1/diagnostics" && request.method === "GET") {
    const now = Date.now();
    writeJSON(response, origin, 200, {
      request_id: requestID,
      server_version: "1.0.0-browser-conformance",
      contract_version: "1.0.0",
      protocol_version: 2,
      installation: installation(authorization.jkt),
      session: { expires_at: new Date(now + 60_000).toISOString(), refresh_available: true },
      trust: trust(now),
    });
    return;
  }
  if (url.pathname === "/client/v1/installations/current" && request.method === "DELETE") {
    state.counters.revocations += 1;
    for (const record of state.accessTokens.values()) {
      if (record.jkt === authorization.jkt) record.revoked = true;
    }
    response.writeHead(204, corsHeaders(origin));
    response.end();
    return;
  }
  if (url.pathname === "/v1/responses" && request.method === "POST") {
    const body = await readJSON(request);
    const input = isRecord(body) && typeof body.input === "string" ? body.input : "";
    streamResponse(request, response, origin, input === "cancel");
    return;
  }
  writeText(response, 404, "not found", corsHeaders(origin));
}

async function serveControl(request, response, url) {
  if (request.method === "POST" && url.pathname === "/__control/reset") {
    state = createState();
    writeJSON(response, undefined, 200, { ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === "/__control/mode") {
    const body = await readJSON(request);
    if (!isRecord(body)) {
      writeText(response, 400, "invalid mode");
      return;
    }
    state.mode = { ...state.mode, ...body };
    writeJSON(response, undefined, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/__control/state") {
    writeJSON(response, undefined, 200, {
      counters: state.counters,
      challengeJkts: state.challengeJkts,
      preflightHeaders: state.preflightHeaders,
      proofIDs: state.proofIDs.size,
      maximumConcurrentRefreshes: state.maximumConcurrentRefreshes,
    });
    return;
  }
  writeText(response, 404, "not found");
}

async function authorizeAccess(request, url) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("DPoP ")) return undefined;
  const token = authorization.slice(5);
  const record = state.accessTokens.get(token);
  if (record === undefined || record.revoked) return undefined;
  const proof = await verifyDPoP(request, url, token);
  if (proof.jkt !== record.jkt) return undefined;
  return record;
}

async function verifyDPoP(request, url, accessToken) {
  const compact = request.headers.dpop;
  if (typeof compact !== "string") throw new Error("missing DPoP proof");
  const parts = compact.split(".");
  if (parts.length !== 3) throw new Error("invalid compact proof");
  const [protectedHeader, protectedPayload, encodedSignature] = parts;
  if (protectedHeader === undefined || protectedPayload === undefined || encodedSignature === undefined) {
    throw new Error("invalid compact proof");
  }
  const header = parseBase64urlJSON(protectedHeader);
  const payload = parseBase64urlJSON(protectedPayload);
  if (!isRecord(header) || header.typ !== "dpop+jwt" || header.alg !== "ES256" || !isP256JWK(header.jwk) ||
      !isRecord(payload) || payload.htm !== request.method ||
      payload.htu !== `${gatewayOrigin}${url.pathname}` || typeof payload.iat !== "number" ||
      Math.abs(payload.iat - Math.floor(Date.now() / 1_000)) > 300 ||
      typeof payload.jti !== "string" || payload.jti.length < 16 || state.proofIDs.has(payload.jti)) {
    throw new Error("invalid DPoP claims");
  }
  if (accessToken === undefined) {
    if (Object.hasOwn(payload, "ath")) throw new Error("unexpected access-token hash");
  } else if (payload.ath !== sha256Base64url(accessToken)) {
    throw new Error("invalid access-token hash");
  }
  const key = await webcrypto.subtle.importKey(
    "jwk",
    header.jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(encodedSignature, "base64url"),
    Buffer.from(`${protectedHeader}.${protectedPayload}`, "utf8"),
  );
  if (!valid) throw new Error("invalid DPoP signature");
  state.proofIDs.add(payload.jti);
  return { jkt: thumbprint(header.jwk) };
}

function issueGrant(jkt) {
  state.tokenCounter += 1;
  const sequence = state.tokenCounter;
  const accessToken = `access-${String(sequence).padStart(4, "0")}-${"a".repeat(70)}`;
  const refreshToken = `refresh-${String(sequence).padStart(4, "0")}-${"r".repeat(40)}`;
  state.accessTokens.set(accessToken, { jkt, revoked: false });
  state.refreshTokens.set(refreshToken, { jkt, used: false });
  const now = Date.now();
  return {
    access_token: accessToken,
    token_type: "DPoP",
    expires_in: 60,
    refresh_token: refreshToken,
    refresh_expires_in: 3_600,
    installation: installation(jkt),
    installation_family: { id: `fam_${"f".repeat(20)}`, status: "active" },
    component: {
      id: `cmp_${"c".repeat(20)}`,
      definition_id: "browser",
      kind: "browser",
      platform: "web",
      is_root: true,
      status: "active",
      dpop_jkt: jkt,
      granted_features: ["habit-assistant"],
    },
    trust: trust(now),
  };
}

function installation(jkt) {
  return {
    id: `ins_${"i".repeat(20)}`,
    platform: "web",
    dpop_jkt: jkt,
    status: "active",
  };
}

function trust(now) {
  return {
    provider: "debug",
    level: "debug",
    source: "debug",
    verified_at: new Date(now).toISOString(),
    expires_at: new Date(now + 300_000).toISOString(),
  };
}

function streamResponse(request, response, origin, cancellable) {
  let finished = false;
  let cancellationRecorded = false;
  const recordCancellation = () => {
    if (!finished && !cancellationRecorded) {
      cancellationRecorded = true;
      state.counters.streamCancellations += 1;
    }
  };
  request.once("aborted", recordCancellation);
  response.once("close", recordCancellation);
  response.writeHead(200, corsHeaders(origin, {
    "Cache-Control": "no-store",
    "Content-Type": "text/event-stream",
    "X-Latchway-Request-ID": requestID,
  }));
  response.write("data: first\n\n");
  state.counters.streamChunks += 1;
  const wait = cancellable ? 2_000 : 40;
  globalThis.setTimeout(() => {
    if (response.destroyed) return;
    response.write("data: second\n\n");
    state.counters.streamChunks += 1;
    finished = true;
    response.end();
  }, wait);
}

function writeProblem(response, origin, code, detail) {
  const policy = problemPolicies[code];
  if (policy === undefined) throw new Error(`Missing problem policy for ${code}.`);
  const documentationURL = `https://docs.latchway.dev/errors/${code.replaceAll("_", "-")}`;
  writeJSON(response, origin, policy.status, {
    type: documentationURL,
    documentation_url: documentationURL,
    title: policy.title,
    status: policy.status,
    detail,
    code,
    request_id: requestID,
    retryable: policy.retryable,
  }, "application/problem+json");
}

function writeJSON(response, origin, status, body, type = "application/json") {
  const content = JSON.stringify(body);
  response.writeHead(status, corsHeaders(origin, {
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(content)),
    "Content-Type": type,
    Date: new Date().toUTCString(),
    "X-Latchway-Request-ID": requestID,
  }));
  response.end(content);
}

function writeText(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    ...extraHeaders,
  });
  response.end(body);
}

function corsHeaders(origin, extra = {}) {
  return {
    ...(origin === undefined ? {} : {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Expose-Headers": "Date, DPoP-Nonce, X-Latchway-Request-ID",
      Vary: "Origin",
    }),
    ...extra,
  };
}

async function readJSON(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 131_072) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseBase64urlJSON(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function isP256JWK(value) {
  return isRecord(value) && value.kty === "EC" && value.crv === "P-256" &&
    typeof value.x === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value.x) &&
    typeof value.y === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value.y);
}

function thumbprint(jwk) {
  const canonical = `{"crv":"P-256","kty":"EC","x":${JSON.stringify(jwk.x)},"y":${JSON.stringify(jwk.y)}}`;
  return sha256Base64url(canonical);
}

function sha256Base64url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function commaSeparated(value) {
  if (typeof value !== "string") return [];
  return value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean).sort();
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeFile(root, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return undefined;
  }
  const target = resolve(root, `.${decoded}`);
  return target === root || target.startsWith(`${root}${sep}`) ? target : undefined;
}

function contentType(path) {
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
  }[extname(path)] ?? "application/octet-stream";
}

function strictCSP() {
  return [
    "default-src 'none'",
    "script-src 'self'",
    `connect-src 'self' ${gatewayOrigin}`,
    "style-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function close(server) {
  return new Promise((resolveClose) => {
    server.close(() => { resolveClose(); });
  });
}
