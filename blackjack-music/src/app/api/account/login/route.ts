import { makeAccountRoutes } from "@musical-daily/accounts/server";
export async function GET(request: Request) {
  // Reading request headers keeps account responses dynamic with Cache Components.
  request.headers.get("cookie");
  return makeAccountRoutes("blackjack").login(request);
}
