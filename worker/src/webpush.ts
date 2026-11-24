/**
 * Web Push from the cloud board, with WebCrypto only (no dependency): the payload encrypted as RFC 8291 says
 * (aes128gcm, RFC 8188), and the board identifying itself to the push service with VAPID (RFC 8292). The keys are
 * the board's own, made on first use (push.ts); no Firebase or other account.
 *
 * `decrypt` is the browser's half, for the tests: a payload that decrypts to what was sent shows both halves agree.
 */

const enc = new TextEncoder();
/** Bytes WebCrypto takes (not a view over a SharedArrayBuffer). */
type Bytes = Uint8Array<ArrayBuffer>;

export const b64u = (bytes: Bytes) => Buffer.from(bytes).toString("base64url");
export const unb64u = (s: string): Bytes => new Uint8Array(Buffer.from(s.replace(/\s+/g, ""), "base64url"));

const concat = (...parts: Bytes[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

async function hmac(key: Bytes, data: Bytes) {
	const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
/** HKDF (RFC 5869) for one block of output at most, which is all Web Push needs. */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number) {
	const prk = await hmac(salt, ikm);
	return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** A P-256 public key as a JWK, from its uncompressed form (0x04 ‖ x ‖ y, 65 bytes). */
export function publicJwk(raw: Bytes, d?: Bytes): JsonWebKey {
	if (raw.length !== 65 || raw[0] !== 4) throw new Error("a P-256 public key is 65 bytes, starting with 4");
	return { kty: "EC", crv: "P-256", x: b64u(raw.slice(1, 33)), y: b64u(raw.slice(33)), ...(d ? { d: b64u(d) } : {}), ext: true };
}
const ecdhPublic = (raw: Bytes) => crypto.subtle.importKey("jwk", publicJwk(raw), { name: "ECDH", namedCurve: "P-256" }, true, []);
const ecdhPrivate = (raw: Bytes, d: Bytes) =>
	crypto.subtle.importKey("jwk", publicJwk(raw, d), { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const rawOf = async (key: CryptoKey) => new Uint8Array(await crypto.subtle.exportKey("raw", key));

/** The content key and nonce both sides work out from the ECDH secret, the auth secret and the salt (RFC 8291 §3.3–3.4). */
async function keys(ecdhSecret: Bytes, auth: Bytes, uaPublic: Bytes, asPublic: Bytes, salt: Bytes) {
	const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
	const ikm = await hkdf(auth, ecdhSecret, keyInfo, 32);
	const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
	return { cek, nonce };
}

/** The record size in the header. A push message is one record, so this only has to be more than it. */
const RS = 4096;

/**
 * The body of a push message: salt ‖ rs ‖ idlen ‖ keyid (the application server's one-off public key) ‖ ciphertext.
 * `fixed` gives the one-off key and the salt, for the RFC's test vector; otherwise they're new each time.
 */
export async function encrypt(
	sub: { p256dh: string; auth: string },
	payload: string | Bytes,
	fixed?: { asPublic: Bytes; asPrivate: Bytes; salt: Bytes },
) {
	const uaPublic = unb64u(sub.p256dh);
	const auth = unb64u(sub.auth);
	if (auth.length < 16) throw new Error("the subscription's auth secret is too short");
	let asPublic: Bytes, asKey: CryptoKey;
	if (fixed) {
		asPublic = fixed.asPublic;
		asKey = await ecdhPrivate(fixed.asPublic, fixed.asPrivate);
	} else {
		const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
		asPublic = await rawOf(pair.publicKey);
		asKey = pair.privateKey;
	}
	const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
	const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await ecdhPublic(uaPublic) }, asKey, 256));
	const { cek, nonce } = await keys(ecdh, auth, uaPublic, asPublic, salt);
	const plain = concat(typeof payload === "string" ? enc.encode(payload) : payload, new Uint8Array([2]));
	if (plain.length + 16 + 86 > RS) throw new Error("a push message holds at most about 4000 bytes");
	const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
	const header = new Uint8Array(21);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RS);
	header[20] = asPublic.length;
	return concat(header, asPublic, cipher);
}

/** The browser's half: the plaintext of a push message body, with the subscription's private key and auth secret. */
export async function decrypt(body: Bytes, ua: { publicKey: Bytes; privateKey: CryptoKey; auth: Bytes }) {
	const salt = body.slice(0, 16);
	const idlen = body[20];
	const asPublic = body.slice(21, 21 + idlen);
	const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await ecdhPublic(asPublic) }, ua.privateKey, 256));
	const { cek, nonce } = await keys(ecdh, ua.auth, ua.publicKey, asPublic, salt);
	const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
	const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, body.slice(21 + idlen)));
	// Padding: trailing zeros, then the last record's delimiter (2).
	let end = plain.length - 1;
	while (end >= 0 && plain[end] === 0) end--;
	if (plain[end] !== 2) throw new Error("not the last record of a push message");
	return plain.slice(0, end);
}

/* ---------- VAPID (RFC 8292) ---------- */

/** The board's VAPID keys: the public one as browsers want it (applicationServerKey, base64url), the private one as a JWK. */
export type Vapid = { publicKey: string; privateJwk: JsonWebKey };

export async function makeVapid(): Promise<Vapid> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	return { publicKey: b64u(await rawOf(pair.publicKey)), privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey };
}

/** The Authorization header for one push service: a JWT for its origin, good for 12 hours, signed with the board's key. */
export async function vapidAuth(endpoint: string, vapid: Vapid, subject: string, now = Date.now()) {
	const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
	const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	// WebCrypto's ECDSA signature is r ‖ s, which is what ES256 wants.
	const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`)));
	return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

export type Subscription = { endpoint: string; p256dh: string; auth: string };

/**
 * Sends one push message. The answer's status is the push service's: 201 sent, 404 or 410 the subscription is gone
 * (the browser unsubscribed, or the app was uninstalled), anything else a problem worth logging.
 */
export async function sendPush(
	sub: Subscription,
	payload: string,
	vapid: Vapid,
	{ subject, ttl = 24 * 3600, urgency = "normal", topic }: { subject: string; ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string },
) {
	const body = await encrypt(sub, payload);
	const headers: Record<string, string> = {
		authorization: await vapidAuth(sub.endpoint, vapid, subject),
		"content-encoding": "aes128gcm",
		"content-type": "application/octet-stream",
		ttl: String(ttl),
		urgency,
	};
	// A topic replaces a message still waiting at the push service for a phone that's off (at most 32 base64url characters).
	if (topic) headers.topic = topic.replace(/[^\w-]/g, "-").slice(0, 32);
	return fetch(sub.endpoint, { method: "POST", headers, body });
}
