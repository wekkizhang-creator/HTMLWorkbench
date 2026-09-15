import { next } from "@vercel/functions";

import { getVercelHostDecision } from "./lib/runtime.mjs";

export const config = {
  matcher: ["/", "/:path*"]
};

export default function middleware(request) {
  const decision = getVercelHostDecision(new URL(request.url), request.method);
  if (decision.action === "next") return next();
  if (decision.action === "redirect") {
    return new Response(null, {
      status: 307,
      headers: { Location: decision.location, "Cache-Control": "no-store" }
    });
  }
  if (decision.action === "not-found") {
    return new Response("Not Found", {
      status: 404,
      headers: { "Cache-Control": "no-store" }
    });
  }
  return new Response("Misdirected Request", {
    status: 421,
    headers: { "Cache-Control": "no-store" }
  });
}
