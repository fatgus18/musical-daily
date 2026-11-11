import { makeAccountRoutes } from "@musical-daily/accounts/server";
export async function POST(request: Request) {
  request.headers.get("cookie");
  return makeAccountRoutes("blackjack").avatar(request);
}
