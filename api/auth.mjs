import { clearAuthCookie, createAuthCookie, isAuthorizedRequest, verifyPassword } from "../lib/auth.mjs";
import { error, json, methodNotAllowed } from "../lib/http.mjs";

export async function GET(request) {
  return json({ authenticated: isAuthorizedRequest(request) });
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!verifyPassword(body.password)) {
      return error("密码不正确", 401);
    }

    return Response.json(
      { authenticated: true },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": createAuthCookie({ secure: new URL(request.url).protocol === "https:" })
        }
      }
    );
  } catch (requestError) {
    return error(requestError.message || "登录失败", requestError.status || 500);
  }
}

export async function DELETE(request) {
  return Response.json(
    { authenticated: false },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": clearAuthCookie({ secure: new URL(request.url).protocol === "https:" })
      }
    }
  );
}

export default {
  async fetch(request) {
    if (request.method === "GET") {
      return GET(request);
    }
    if (request.method === "POST") {
      return POST(request);
    }
    if (request.method === "DELETE") {
      return DELETE(request);
    }
    return methodNotAllowed();
  }
};
