// Web Push's encryption and VAPID (worker/src/webpush.ts), against RFC 8291's own example (section 5, appendix A).
import { describe, expect, test } from "bun:test";
import { b64u, decrypt, encrypt, makeVapid, publicJwk, unb64u, vapidAuth } from "../src/webpush";

const RFC = {
	plaintext: "When I grow up, I want to be a watermelon",
	asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	// The whole message, header and ciphertext (section 5).
	message:
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("RFC 8291", () => {
	test("the example encrypts to exactly the RFC's message", async () => {
		const out = await encrypt({ p256dh: RFC.uaPublic, auth: RFC.auth }, RFC.plaintext, {
			asPublic: unb64u(RFC.asPublic),
			asPrivate: unb64u(RFC.asPrivate),
			salt: unb64u(RFC.salt),
		});
		expect(b64u(out)).toBe(RFC.message);
	});

	test("the RFC's message decrypts with the user agent's key", async () => {
		const privateKey = await crypto.subtle.importKey("jwk", publicJwk(unb64u(RFC.uaPublic), unb64u(RFC.uaPrivate)), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
		const plain = await decrypt(unb64u(RFC.message), { publicKey: unb64u(RFC.uaPublic), privateKey, auth: unb64u(RFC.auth) });
		expect(new TextDecoder().decode(plain)).toBe(RFC.plaintext);
	});

	test("a fresh key and salt each time, and it still decrypts", async () => {
		const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
		const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
		const auth = crypto.getRandomValues(new Uint8Array(16));
		const sub = { p256dh: b64u(publicKey), auth: b64u(auth) };
		const text = JSON.stringify({ title: "Needs you · Ελληνικά", body: "x".repeat(2000) });
		const a = await encrypt(sub, text);
		const b = await encrypt(sub, text);
		expect(b64u(a.slice(0, 16))).not.toBe(b64u(b.slice(0, 16)));
		expect(new TextDecoder().decode(await decrypt(a, { publicKey, privateKey: ua.privateKey, auth }))).toBe(text);
		await expect(encrypt(sub, "x".repeat(5000))).rejects.toThrow("4000 bytes");
	});
});

describe("VAPID", () => {
	test("a JWT for the push service's origin, signed with the board's key", async () => {
		const vapid = await makeVapid();
		const now = Date.UTC(2026, 10, 24);
		const header = await vapidAuth("https://fcm.googleapis.com/fcm/send/abc", vapid, "https://board.example", now);
		const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)!;
		expect(m[4]).toBe(vapid.publicKey);
		expect(JSON.parse(Buffer.from(m[1], "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
		expect(JSON.parse(Buffer.from(m[2], "base64url").toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "https://board.example" });
		const key = await crypto.subtle.importKey("jwk", publicJwk(unb64u(vapid.publicKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
		const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64u(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`));
		expect(ok).toBe(true);
	});
});
