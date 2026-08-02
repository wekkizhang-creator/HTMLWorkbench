import { error } from "../lib/http.mjs";
import { checkStorageReadiness } from "../lib/storage.mjs";

export async function GET() {
  try {
    await checkStorageReadiness();
    return Response.json({ status: "ok" }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export default {
  async fetch(request) {
    if (request.method === "GET") return GET(request);
    return error("Method not allowed", 405);
  }
};
