/**
 * Response helper for the deliberate browser-held-token posture. The web
 * session still stores the id_token in an httpOnly cookie; the authenticated
 * same-origin endpoint exposes it only to the current page's JavaScript so it
 * can call hq-pro directly with a Bearer. It is never included in page data.
 */
export function clientTokenResponse(idToken: string | null): Response {
  if (!idToken) {
    return new Response(
      JSON.stringify({ error: "Unauthenticated", code: "UNAUTHENTICATED" }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      },
    );
  }
  return new Response(JSON.stringify({ idToken }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
