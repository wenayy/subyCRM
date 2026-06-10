import fetch from "node-fetch";

async function main() {
  const res = await fetch("http://localhost:23373/v1/spec");
  const spec = await res.json() as any;
  console.log("SendMessageOutput schema:");
  console.log(JSON.stringify(spec.components?.schemas?.SendMessageOutput, null, 2));
}

main().catch(console.error);
