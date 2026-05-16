export function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

export function error(message, status = 400) {
  return json({ error: message }, status);
}

export function methodNotAllowed() {
  return error("请求方法不支持", 405);
}
