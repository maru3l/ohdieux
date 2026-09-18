const baseUrl = process.argv[2] ?? process.env.PROOF_URL;

if (!baseUrl) {
  console.error("Usage: node run-proof.mjs <worker-url>");
  process.exit(2);
}

const response = await fetch(new URL("/proof", baseUrl), { method: "POST" });
const body = await response.text();

if (!response.ok) {
  console.error(body);
  process.exit(1);
}

const proof = JSON.parse(body);
console.log(JSON.stringify(proof, null, 2));
process.exit(proof.verdict === "proved" ? 0 : 1);
