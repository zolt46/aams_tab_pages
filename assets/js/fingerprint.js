// Placeholder: when bridge is not ready, just return true for demo.
export async function verifyFingerprint(){
try {
const res = await fetch('/fingerprint/check', { credentials: 'include' });
if (res.ok) { const { match } = await res.json(); return !!match; }
} catch {}
return true; // demo pass-through
}